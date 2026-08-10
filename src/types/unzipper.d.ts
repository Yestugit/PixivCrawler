declare module 'unzipper' {
  import type { Readable } from 'node:stream'
  interface Entry { path: string; type: 'File' | 'Directory'; uncompressedSize: number; stream(): Readable }
  interface Directory { files: Entry[] }
  export const Open: { file(path: string): Promise<Directory> }
}
