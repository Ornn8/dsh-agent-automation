# Trusted verification-contract foundation

Profiles may explicitly locate a bounded verification contract relative to their Profile directory. The controller validates version, identity, required checks, and required evidence, canonicalizes their order, freezes the result, and derives a SHA-256 hash. Trusted Profile loading reads the contract with the same repository and full revision as the Profile; an absent or invalid configured contract fails closed. Profiles without a locator keep the existing loading result and do not receive an implicit contract.
