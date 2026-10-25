import { Item } from "../model";
export interface Detection {
  detectedBy: string[]; // reasons the agent is "in use" on this machine
  repoFiles: string[]; // project files that mention this agent (display only)
}
export interface AdapterResult {
  items: Item[];
  unmeasuredBanner: string[];
}
