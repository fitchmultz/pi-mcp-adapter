import type { Entry as NativeEntry } from "@napi-rs/keyring";

class Entry implements Pick<NativeEntry, "getPassword" | "setPassword" | "deleteCredential"> {
  readonly service: string;
  readonly account: string;

  constructor(service: string, account: string) {
    this.service = service;
    this.account = account;
  }

  getPassword(): null {
    return null;
  }

  setPassword(): never {
    throw new Error("The native loader read probe must not write a credential");
  }

  deleteCredential(): never {
    throw new Error("The native loader read probe must not delete a credential");
  }
}

module.exports = { Entry };
