// Vitest setup. The window tests drive the whole app with the mock backend and wait on what it
// draws; on a loaded machine (several builds at once) that takes longer than Testing Library's default
// one-second wait, and some tests longer than Vitest's default five seconds. They wait on conditions,
// not on time, so a longer budget changes nothing when the machine is idle.
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 10000 });
