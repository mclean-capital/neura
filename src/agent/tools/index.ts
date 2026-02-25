import { shellExecute } from "./shell.js";

export function getTools() {
  return {
    shell_execute: shellExecute,
  };
}
