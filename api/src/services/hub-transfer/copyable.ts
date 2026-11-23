/**
 * P6-31: the saved-settings storage drivers whose objects a move's pull can copy
 * (`nivaro_files.storage` as storage-drivers.ts names them). A leaf module: the plan imports it
 * without the pull's I/O.
 */
export const COPYABLE_OBJECT_STORAGE = ['s3', 'azure-blob'] as const
