import type { Config } from '../gcm.config.js';
import type { CommitActionService } from './commit-action-service.js';
import type { InteractiveGenerationDialogue } from './interactive-generation-dialogue.js';
import type { LanguageModelService } from './language-model-service.js';
import type { ModelSpec } from './model-registry.js';
import type { ProjectConfig } from './project-config.js';
import type { CommitContextHints } from './scope-detector.js';
import type { ContextService } from './services/context-service.js';
import type { GitService } from './services/git-service.js';
import type { GCMSession } from './session.js';

export interface GenerationServices {
  config: Config;
  projectConfig?: ProjectConfig;
  gitService: GitService;
  contextService: ContextService;
  languageModelService: LanguageModelService;
  providerId: string;
  providerLabel: string;
  models: () => Promise<ModelSpec[]>;
  dialogue: InteractiveGenerationDialogue;
  commitActions: CommitActionService;
  getCommitContextHints: (files: string[]) => Promise<CommitContextHints>;
  saveSession: (session: GCMSession) => Promise<void>;
  output: {
    isInteractive: boolean;
    startProgress: (message: string) => void;
    /** Without a message the progress indicator is removed without a line. */
    stopProgress: (message?: string) => void;
    cancel: (message: string) => void;
    note: (message: string, title?: string) => void;
    warn: (message: string, title?: string) => void;
    outro: (message: string) => void;
    print: (message: string) => void;
    sanitizeGeneratedText: (message: string) => string;
    sanitizeTerminalText: (message: string) => string;
    style: {
      cyan: (message: string) => string;
      dim: (message: string) => string;
      yellow: (message: string) => string;
    };
  };
}

export interface ProviderSwitchOutcome {
  type: 'switch-provider';
  providerId: string;
}
export type TerminalOutcome = 'success' | 'failure' | ProviderSwitchOutcome;
