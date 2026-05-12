// ModPilot Devvit app — entry point
// Detail: docs/03-Devvit.md, docs/Specs.md §6
//
// This file wires triggers, menu actions, scheduled jobs, and custom posts.
// Real implementations land in F-0.4 (skeleton) and S-1.1+ (CommentReport trigger).

import { Devvit } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: true,
});

// TODO(F-0.4): register triggers from src/triggers/
// TODO(F-0.4): register menu actions from src/menu/
// TODO(F-0.4): register scheduled jobs from src/jobs/
// TODO(U-4.1): register Mod Dashboard custom post
// TODO(U-4.3): register First-Run Wizard custom post

export default Devvit;
