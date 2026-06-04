declare module 'tree-kill' {
  function treeKill(pid: number, signal?: string | number, callback?: (error?: Error) => void): void;
  function treeKill(pid: number, callback?: (error?: Error) => void): void;
  export = treeKill;
}
