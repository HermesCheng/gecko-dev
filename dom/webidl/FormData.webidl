/* -*- Mode: IDL; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * The origin of this IDL file is
 * http://xhr.spec.whatwg.org
 */

typedef (File or USVString) FormDataEntryValue;

[Constructor(optional HTMLFormElement form)]
interface FormData {
  void append(USVString name, Blob value, optional USVString filename);
  void append(USVString name, USVString value);
  void delete(USVString name);
  FormDataEntryValue? get(USVString name);
  sequence<FormDataEntryValue> getAll(USVString name);
  boolean has(USVString name);
  void set(USVString name, Blob value, optional USVString filename);
  void set(USVString name, USVString value);
  // iterable<USVString, FormDataEntryValue>; - Bug 1127703
};
