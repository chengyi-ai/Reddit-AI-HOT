// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import type { ServerModule } from "@aihot/backend/modules";
import { server as feedbackRetention } from "@aihot/feedback-retention/server";
import { server as redditVotes } from "@aihot/reddit-votes/server";

export const SERVER_MODULES: readonly ServerModule[] = [feedbackRetention, redditVotes];
