import type { Instance, Role, Task } from "./types";

/**
 * v4 robot character registry.
 *
 * Only two characters: the builder robot Bolt and the scheduler robot Relay.
 * Everything is hand-drawn SVG with no external images; state drives expression and animation, not decoration.
 */
export type CharacterState = "working" | "idle" | "rest" | "alert" | "offline";

export interface RoleCharacter {
  role: Role;
  name: string;
  title: string;
  tagline: string;
  /** Shell primary color */
  color: string;
  /** Dark outline / shadow */
  accent: string;
  /** Screen face base color */
  screen: string;
  /** LED eyes / indicator lights */
  led: string;
  props: string;
  quotes: Record<CharacterState, string>;
  skills: string[];
  agentHints: string[];
}

export const CHARACTERS: Record<Role, RoleCharacter> = {
  builder: {
    role: "builder",
    name: "Tamp",
    title: "Builder bot · Builder",
    tagline: "Give me a command, and I'll give you a result that runs.",
    color: "#e08a2e",
    accent: "#a45a12",
    screen: "#1f2430",
    led: "#5fe0c0",
    props: "Orange workwear · wrench antenna · code particles",
    quotes: {
      working: "Compiling — don't rush me, the fans are spinning up.",
      idle: "The workbench is warm. What's the next command?",
      rest: "Idling… I'll light up when a task arrives.",
      alert: "The build failed. I'm digging through the logs.",
      offline: "The builder is offline.",
    },
    skills: ["shell", "build", "ssh"],
    agentHints: ["Claude Code", "Codex", "DeepSeek Coder"],
  },
  scheduler: {
    role: "scheduler",
    name: "Relay",
    title: "Scheduler bot · Scheduler",
    tagline: "Rules dispatch, Agents explain; no guessing, no grabbing, no queue-jumping.",
    color: "#2f8f83",
    accent: "#1c5f57",
    screen: "#16202a",
    led: "#f0c75e",
    props: "Hover ring · chest clock · task list",
    quotes: {
      working: "Queuing and dispatching; the queue never jumps itself.",
      idle: "Queue is steady, waiting for tasks.",
      rest: "No dispatching at night unless a lease expires.",
      alert: "Queue backlog or lost builder — checking now.",
      offline: "The dispatch desk is down.",
    },
    skills: ["queue", "lease", "fencing"],
    agentHints: ["DeepSeek dispatch assistant"],
  },
};

/** Derive the robot's current state from instances and tasks. */
export function characterState(instance: Instance | undefined, runningTask?: Task): CharacterState {
  if (!instance) return "idle";
  if (instance.state === "OFFLINE" || instance.state === "FAILED") return "offline";
  if (instance.state === "SUSPECT" || instance.state === "DRAINING") return "alert";
  if (runningTask) return "working";
  if (instance.state === "ONLINE") return "idle";
  return "rest";
}

export function characterOf(role: Role): RoleCharacter {
  return CHARACTERS[role];
}
