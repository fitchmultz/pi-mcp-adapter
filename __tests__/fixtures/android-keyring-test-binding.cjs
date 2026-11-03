/** @type {Map<string, string>} */
const entries = new Map();

class Entry {
  /** @param {string} service @param {string} account */
  constructor(service, account) {
    this.account = service + account;
  }

  getPassword() {
    if (binding.failure !== undefined) {
      throw binding.failure;
    }
    return entries.get(this.account) ?? null;
  }

  /** @param {string} value */
  setPassword(value) {
    if (binding.failure !== undefined) {
      throw binding.failure;
    }
    entries.set(this.account, value);
  }

  deleteCredential() {
    if (binding.failure !== undefined) {
      throw binding.failure;
    }
    return entries.delete(this.account);
  }
}

/** @type {{ failure: Error | undefined; Entry: typeof Entry }} */
const binding = { failure: undefined, Entry };
module.exports = binding;
