export interface NativeBackupSelection {
  generation_id: string
  harness: string
  native_id: string
  storage_root: string
}
export interface NativeBackupProfile {
  root: string
  files: string[]
  assertConsistent: () => Promise<void>
}
/** No vendor session format has passed backup consistency certification yet. */
export const nativeBackupProfile = (
  _selection: NativeBackupSelection
): NativeBackupProfile | null => null
