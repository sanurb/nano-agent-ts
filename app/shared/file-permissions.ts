/** Private files grant read/write authority only to their owner; never broaden an existing target's mode. */
export const privateFileMode = 0o600;

/** Private directories grant traversal, listing, and mutation only to their owner. */
export const privateDirectoryMode = 0o700;
