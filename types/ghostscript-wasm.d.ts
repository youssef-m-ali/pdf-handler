declare module "@jspawn/ghostscript-wasm" {
  interface GhostscriptModule {
    callMain(args: string[]): void;
    FS: {
      writeFile(path: string, data: Uint8Array): void;
      readFile(path: string): Uint8Array;
      unlink(path: string): void;
    };
  }

  function Module(opts?: { locateFile?: (path: string) => string }): Promise<GhostscriptModule>;
  export default Module;
}
