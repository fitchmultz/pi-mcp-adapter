import type { AsyncEntry as NativeAsyncEntry } from "@napi-rs/keyring";

class AsyncEntry implements Pick<
  NativeAsyncEntry,
  "getPassword" | "setPassword" | "deleteCredential"
> {
  readonly service: string;
  readonly account: string;

  constructor(service: string, account: string) {
    this.service = service;
    this.account = account;
  }

  async getPassword(): Promise<null> {
    // Yield across a real timer so tests can observe event-loop progress during keyring IPC.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    return null;
  }

  async setPassword(): Promise<never> {
    throw new Error("The native loader read probe must not write a credential");
  }

  async deleteCredential(): Promise<never> {
    throw new Error("The native loader read probe must not delete a credential");
  }
}

module.exports = { AsyncEntry };
