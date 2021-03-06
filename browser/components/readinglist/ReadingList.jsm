/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = [
  "ReadingList",
];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/Log.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "SQLiteStore",
  "resource:///modules/readinglist/SQLiteStore.jsm");


{ // Prevent the parent log setup from leaking into the global scope.
  let parentLog = Log.repository.getLogger("readinglist");
  parentLog.level = Preferences.get("browser.readinglist.logLevel", Log.Level.Warn);
  Preferences.observe("browser.readinglist.logLevel", value => {
    parentLog.level = value;
  });
  let formatter = new Log.BasicFormatter();
  parentLog.addAppender(new Log.ConsoleAppender(formatter));
  parentLog.addAppender(new Log.DumpAppender(formatter));
}
let log = Log.repository.getLogger("readinglist.api");


// Names of basic properties on ReadingListItem.
const ITEM_BASIC_PROPERTY_NAMES = `
  guid
  lastModified
  url
  title
  resolvedURL
  resolvedTitle
  excerpt
  status
  favorite
  isArticle
  wordCount
  unread
  addedBy
  addedOn
  storedOn
  markedReadBy
  markedReadOn
  readPosition
`.trim().split(/\s+/);

/**
 * A reading list contains ReadingListItems.
 *
 * A list maintains only one copy of an item per URL.  So if for example you use
 * an iterator to get two references to items with the same URL, your references
 * actually refer to the same JS object.
 *
 * Options Objects
 * ---------------
 *
 * Some methods on ReadingList take an "optsList", a variable number of
 * arguments, each of which is an "options object".  Options objects let you
 * control the items that the method acts on.
 *
 * Each options object is a simple object with properties whose names are drawn
 * from ITEM_BASIC_PROPERTY_NAMES.  For an item to match an options object, the
 * properties of the item must match all the properties in the object.  For
 * example, an object { guid: "123" } matches any item whose GUID is 123.  An
 * object { guid: "123", title: "foo" } matches any item whose GUID is 123 *and*
 * whose title is foo.
 *
 * You can pass multiple options objects as separate arguments.  For an item to
 * match multiple objects, its properties must match all the properties in at
 * least one of the objects.  For example, a list of objects { guid: "123" } and
 * { title: "foo" } matches any item whose GUID is 123 *or* whose title is
 * foo.
 *
 * The properties in an options object can be arrays, not only scalars.  When a
 * property is an array, then for an item to match, its corresponding property
 * must have a value that matches any value in the array.  For example, an
 * options object { guid: ["123", "456"] } matches any item whose GUID is either
 * 123 *or* 456.
 *
 * In addition to properties with names from ITEM_BASIC_PROPERTY_NAMES, options
 * objects can also have the following special properties:
 *
 *   * sort: The name of a property to sort on.
 *   * descending: A boolean, true to sort descending, false to sort ascending.
 *     If `sort` is given but `descending` isn't, the sort is ascending (since
 *     `descending` is falsey).
 *   * limit: Limits the number of matching items to this number.
 *   * offset: Starts matching items at this index in the results.
 *
 * Since you can pass multiple options objects in a list, you can include these
 * special properties in any number of the objects in the list, but it doesn't
 * really make sense to do so.  The last property in the list is the one that's
 * used.
 *
 * @param store Backing storage for the list.  See SQLiteStore.jsm for what this
 *        object's interface should look like.
 */
function ReadingListImpl(store) {
  this._store = store;
  this._itemsByURL = new Map();
  this._iterators = new Set();
  this._listeners = new Set();
}

ReadingListImpl.prototype = {

  ItemBasicPropertyNames: ITEM_BASIC_PROPERTY_NAMES,

  /**
   * Yields the number of items in the list.
   *
   * @param optsList A variable number of options objects that control the
   *        items that are matched.  See Options Objects.
   * @return Promise<number> The number of matching items in the list.  Rejected
   *         with an Error on error.
   */
  count: Task.async(function* (...optsList) {
    return (yield this._store.count(...optsList));
  }),

  /**
   * Enumerates the items in the list that match the given options.
   *
   * @param callback Called for each item in the enumeration.  It's passed a
   *        single object, a ReadingListItem.  It may return a promise; if so,
   *        the callback will not be called for the next item until the promise
   *        is resolved.
   * @param optsList A variable number of options objects that control the
   *        items that are matched.  See Options Objects.
   * @return Promise<null> Resolved when the enumeration completes *and* the
   *         last promise returned by the callback is resolved.  Rejected with
   *         an Error on error.
   */
  forEachItem: Task.async(function* (callback, ...optsList) {
    let promiseChain = Promise.resolve();
    yield this._store.forEachItem(obj => {
      promiseChain = promiseChain.then(() => {
        return new Promise((resolve, reject) => {
          let promise = callback(this._itemFromObject(obj));
          if (promise instanceof Promise) {
            return promise.then(resolve, reject);
          }
          resolve();
          return undefined;
        });
      });
    }, ...optsList);
    yield promiseChain;
  }),

  /**
   * Returns a new ReadingListItemIterator that can be used to enumerate items
   * in the list.
   *
   * @param optsList A variable number of options objects that control the
   *        items that are matched.  See Options Objects.
   * @return A new ReadingListItemIterator.
   */
  iterator(...optsList) {
    let iter = new ReadingListItemIterator(this, ...optsList);
    this._iterators.add(Cu.getWeakReference(iter));
    return iter;
  },

  /**
   * Adds an item to the list that isn't already present.
   *
   * The given object represents a new item, and the properties of the object
   * are those in ITEM_BASIC_PROPERTY_NAMES.  It may have as few or as many
   * properties that you want to set, but it must have a `url` property.
   *
   * It's an error to call this with an object whose `url` or `guid` properties
   * are the same as those of items that are already present in the list.  The
   * returned promise is rejected in that case.
   *
   * @param obj A simple object representing an item.
   * @return Promise<ReadingListItem> Resolved with the new item when the list
   *         is updated.  Rejected with an Error on error.
   */
  addItem: Task.async(function* (obj) {
    obj = stripNonItemProperties(obj);
    yield this._store.addItem(obj);
    this._invalidateIterators();
    let item = this._itemFromObject(obj);
    this._callListeners("onItemAdded", item);
    return item;
  }),

  /**
   * Updates the properties of an item that belongs to the list.
   *
   * The passed-in item may have as few or as many properties that you want to
   * set; only the properties that are present are updated.  The item must have
   * a `url`, however.
   *
   * It's an error to call this for an item that doesn't belong to the list.
   * The returned promise is rejected in that case.
   *
   * @param item The ReadingListItem to update.
   * @return Promise<null> Resolved when the list is updated.  Rejected with an
   *         Error on error.
   */
  updateItem: Task.async(function* (item) {
    this._ensureItemBelongsToList(item);
    yield this._store.updateItem(item._properties);
    this._invalidateIterators();
    this._callListeners("onItemUpdated", item);
  }),

  /**
   * Deletes an item from the list.  The item must have a `url`.
   *
   * It's an error to call this for an item that doesn't belong to the list.
   * The returned promise is rejected in that case.
   *
   * @param item The ReadingListItem to delete.
   * @return Promise<null> Resolved when the list is updated.  Rejected with an
   *         Error on error.
   */
  deleteItem: Task.async(function* (item) {
    this._ensureItemBelongsToList(item);
    yield this._store.deleteItemByURL(item.url);
    item.list = null;
    this._itemsByURL.delete(item.url);
    this._invalidateIterators();
    this._callListeners("onItemDeleted", item);
  }),

  /**
   * Adds a listener that will be notified when the list changes.  Listeners
   * are objects with the following optional methods:
   *
   *   onItemAdded(item)
   *   onItemUpdated(item)
   *   onItemDeleted(item)
   *
   * @param listener A listener object.
   */
  addListener(listener) {
    this._listeners.add(listener);
  },

  /**
   * Removes a listener from the list.
   *
   * @param listener A listener object.
   */
  removeListener(listener) {
    this._listeners.delete(listener);
  },

  /**
   * Call this when you're done with the list.  Don't use it afterward.
   */
  destroy: Task.async(function* () {
    yield this._store.destroy();
    for (let itemWeakRef of this._itemsByURL.values()) {
      let item = itemWeakRef.get();
      if (item) {
        item.list = null;
      }
    }
    this._itemsByURL.clear();
  }),

  // The list's backing store.
  _store: null,

  // A Map mapping URL strings to nsIWeakReferences that refer to
  // ReadingListItems.
  _itemsByURL: null,

  // A Set containing nsIWeakReferences that refer to valid iterators produced
  // by the list.
  _iterators: null,

  // A Set containing listener objects.
  _listeners: null,

  /**
   * Returns the ReadingListItem represented by the given simple object.  If
   * the item doesn't exist yet, it's created first.
   *
   * @param obj A simple object with item properties.
   * @return The ReadingListItem.
   */
  _itemFromObject(obj) {
    let itemWeakRef = this._itemsByURL.get(obj.url);
    let item = itemWeakRef ? itemWeakRef.get() : null;
    if (item) {
      item.setProperties(obj, false);
    }
    else {
      item = new ReadingListItem(obj);
      item.list = this;
      this._itemsByURL.set(obj.url, Cu.getWeakReference(item));
    }
    return item;
  },

  /**
   * Marks all the list's iterators as invalid, meaning it's not safe to use
   * them anymore.
   */
  _invalidateIterators() {
    for (let iterWeakRef of this._iterators) {
      let iter = iterWeakRef.get();
      if (iter) {
        iter.invalidate();
      }
    }
    this._iterators.clear();
  },

  /**
   * Calls a method on all listeners.
   *
   * @param methodName The name of the method to call.
   * @param item This item will be passed to the listeners.
   */
  _callListeners(methodName, item) {
    for (let listener of this._listeners) {
      if (methodName in listener) {
        try {
          listener[methodName](item);
        }
        catch (err) {
          Cu.reportError(err);
        }
      }
    }
  },

  _ensureItemBelongsToList(item) {
    if (item.list != this) {
      throw new Error("The item does not belong to this list");
    }
  },
};

/**
 * An item in a reading list.
 *
 * Each item belongs to a list, and it's an error to use an item with a
 * ReadingList that the item doesn't belong to.
 *
 * @param props The properties of the item, as few or many as you want.
 */
function ReadingListItem(props={}) {
  this._properties = {};
  this.setProperties(props, false);
}

ReadingListItem.prototype = {

  /**
   * Item's unique ID.
   * @type string
   */
  get id() {
    if (!this._id) {
      this._id = hash(this.url);
    }
    return this._id;
  },

  /**
   * The item's server-side GUID. This is set by the remote server and therefore is not
   * guarenteed to be set for local items.
   * @type string
   */
  get guid() {
    return this._properties.guid || undefined;
  },
  set guid(val) {
    this._properties.guid = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The date the item was last modified.
   * @type Date
   */
  get lastModified() {
    return this._properties.lastModified ?
           new Date(this._properties.lastModified) :
           undefined;
  },
  set lastModified(val) {
    this._properties.lastModified = val.valueOf();
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's URL.
   * @type string
   */
  get url() {
    return this._properties.url;
  },
  set url(val) {
    this._properties.url = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's URL as an nsIURI.
   * @type nsIURI
   */
  get uri() {
    return this._properties.url ?
           Services.io.newURI(this._properties.url, "", null) :
           undefined;
  },
  set uri(val) {
    this.url = val.spec;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * Returns the domain (a string) of the item's URL.  If the URL doesn't have a
   * domain, then the URL itself (also a string) is returned.
   */
  get domain() {
    try {
      return this.uri.host;
    }
    catch (err) {}
    return this.url;
  },

  /**
   * The item's resolved URL.
   * @type string
   */
  get resolvedURL() {
    return this._properties.resolvedURL;
  },
  set resolvedURL(val) {
    this._properties.resolvedURL = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's resolved URL as an nsIURI.
   * @type nsIURI
   */
  get resolvedURI() {
    return this._properties.resolvedURL ?
           Services.io.newURI(this._properties.resolvedURL, "", null) :
           undefined;
  },
  set resolvedURI(val) {
    this.resolvedURL = val.spec;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's title.
   * @type string
   */
  get title() {
    return this._properties.title;
  },
  set title(val) {
    this._properties.title = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's resolved title.
   * @type string
   */
  get resolvedTitle() {
    return this._properties.resolvedTitle;
  },
  set resolvedTitle(val) {
    this._properties.resolvedTitle = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's excerpt.
   * @type string
   */
  get excerpt() {
    return this._properties.excerpt;
  },
  set excerpt(val) {
    this._properties.excerpt = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's status.
   * @type integer
   */
  get status() {
    return this._properties.status;
  },
  set status(val) {
    this._properties.status = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * Whether the item is a favorite.
   * @type boolean
   */
  get favorite() {
    return !!this._properties.favorite;
  },
  set favorite(val) {
    this._properties.favorite = !!val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * Whether the item is an article.
   * @type boolean
   */
  get isArticle() {
    return !!this._properties.isArticle;
  },
  set isArticle(val) {
    this._properties.isArticle = !!val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's word count.
   * @type integer
   */
  get wordCount() {
    return this._properties.wordCount;
  },
  set wordCount(val) {
    this._properties.wordCount = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * Whether the item is unread.
   * @type boolean
   */
  get unread() {
    return !!this._properties.unread;
  },
  set unread(val) {
    this._properties.unread = !!val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The date the item was added.
   * @type Date
   */
  get addedOn() {
    return this._properties.addedOn ?
           new Date(this._properties.addedOn) :
           undefined;
  },
  set addedOn(val) {
    this._properties.addedOn = val.valueOf();
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The date the item was stored.
   * @type Date
   */
  get storedOn() {
    return this._properties.storedOn ?
           new Date(this._properties.storedOn) :
           undefined;
  },
  set storedOn(val) {
    this._properties.storedOn = val.valueOf();
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The GUID of the device that marked the item read.
   * @type string
   */
  get markedReadBy() {
    return this._properties.markedReadBy;
  },
  set markedReadBy(val) {
    this._properties.markedReadBy = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The date the item marked read.
   * @type Date
   */
  get markedReadOn() {
    return this._properties.markedReadOn ?
           new Date(this._properties.markedReadOn) :
           undefined;
  },
  set markedReadOn(val) {
    this._properties.markedReadOn = val.valueOf();
    if (this.list) {
      this.commit();
    }
  },

  /**
   * The item's read position.
   * @param integer
   */
  get readPosition() {
    return this._properties.readPosition;
  },
  set readPosition(val) {
    this._properties.readPosition = val;
    if (this.list) {
      this.commit();
    }
  },

  /**
   * Sets the given properties of the item, optionally calling commit().
   *
   * @param props A simple object containing the properties to set.
   * @param commit If true, commit() is called.
   * @return Promise<null> If commit is true, resolved when the commit
   *         completes; otherwise resolved immediately.
   */
  setProperties: Task.async(function* (props, commit=true) {
    for (let name in props) {
      this._properties[name] = props[name];
    }
    if (commit) {
      yield this.commit();
    }
  }),

  /**
   * Deletes the item from its list.
   *
   * @return Promise<null> Resolved when the list has been updated.
   */
  delete: Task.async(function* () {
    this._ensureBelongsToList();
    yield this.list.deleteItem(this);
    this.delete = () => Promise.reject("The item has already been deleted");
  }),

  /**
   * Notifies the item's list that the item has changed so that the list can
   * update itself.
   *
   * @return Promise<null> Resolved when the list has been updated.
   */
  commit: Task.async(function* () {
    this._ensureBelongsToList();
    yield this.list.updateItem(this);
  }),

  toJSON() {
    return this._properties;
  },

  _ensureBelongsToList() {
    if (!this.list) {
      throw new Error("The item must belong to a reading list");
    }
  },
};

/**
 * An object that enumerates over items in a list.
 *
 * You can enumerate items a chunk at a time by passing counts to forEach() and
 * items().  An iterator remembers where it left off, so for example calling
 * forEach() with a count of 10 will enumerate the first 10 items, and then
 * calling it again with 10 will enumerate the next 10 items.
 *
 * It's possible for an iterator's list to be modified between calls to
 * forEach() and items().  If that happens, the iterator is no longer safe to
 * use, so it's invalidated.  You can check whether an iterator is invalid by
 * getting its `invalid` property.  Attempting to use an invalid iterator will
 * throw an error.
 *
 * @param list The ReadingList to enumerate.
 * @param optsList A variable number of options objects that control the items
 *        that are matched.  See Options Objects.
 */
function ReadingListItemIterator(list, ...optsList) {
  this.list = list;
  this.index = 0;
  this.optsList = optsList;
}

ReadingListItemIterator.prototype = {

  /**
   * True if it's not safe to use the iterator.  Attempting to use an invalid
   * iterator will throw an error.
   */
  invalid: false,

  /**
   * Enumerates the items in the iterator starting at its current index.  The
   * iterator is advanced by the number of items enumerated.
   *
   * @param callback Called for each item in the enumeration.  It's passed a
   *        single object, a ReadingListItem.  It may return a promise; if so,
   *        the callback will not be called for the next item until the promise
   *        is resolved.
   * @param count The maximum number of items to enumerate.  Pass -1 to
   *        enumerate them all.
   * @return Promise<null> Resolved when the enumeration completes *and* the
   *         last promise returned by the callback is resolved.
   */
  forEach: Task.async(function* (callback, count=-1) {
    this._ensureValid();
    let optsList = clone(this.optsList);
    optsList.push({
      offset: this.index,
      limit: count,
    });
    yield this.list.forEachItem(item => {
      this.index++;
      return callback(item);
    }, ...optsList);
  }),

  /**
   * Gets an array of items in the iterator starting at its current index.  The
   * iterator is advanced by the number of items fetched.
   *
   * @param count The maximum number of items to get.
   * @return Promise<array> The fetched items.
   */
  items: Task.async(function* (count) {
    this._ensureValid();
    let optsList = clone(this.optsList);
    optsList.push({
      offset: this.index,
      limit: count,
    });
    let items = [];
    yield this.list.forEachItem(item => items.push(item), ...optsList);
    this.index += items.length;
    return items;
  }),

  /**
   * Invalidates the iterator.  You probably don't want to call this unless
   * you're a ReadingList.
   */
  invalidate() {
    this.invalid = true;
  },

  _ensureValid() {
    if (this.invalid) {
      throw new Error("The iterator has been invalidated");
    }
  },
};


function stripNonItemProperties(item) {
  let obj = {};
  for (let name of ITEM_BASIC_PROPERTY_NAMES) {
    if (name in item) {
      obj[name] = item[name];
    }
  }
  return obj;
}

function hash(str) {
  let hasher = Cc["@mozilla.org/security/hash;1"].
               createInstance(Ci.nsICryptoHash);
  hasher.init(Ci.nsICryptoHash.MD5);
  let stream = Cc["@mozilla.org/io/string-input-stream;1"].
               createInstance(Ci.nsIStringInputStream);
  stream.data = str;
  hasher.updateFromStream(stream, -1);
  let binaryStr = hasher.finish(false);
  let hexStr =
    [("0" + binaryStr.charCodeAt(i).toString(16)).slice(-2) for (i in hash)].
    join("");
  return hexStr;
}

function clone(obj) {
  return Cu.cloneInto(obj, {}, { cloneFunctions: false });
}


Object.defineProperty(this, "ReadingList", {
  get() {
    if (!this._singleton) {
      let store = new SQLiteStore("reading-list-temp.sqlite");
      this._singleton = new ReadingListImpl(store);
    }
    return this._singleton;
  },
});
