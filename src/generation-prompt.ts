import type { ProjectConfig } from './project-config.js';
import { hasText } from './utils.js';

const DEFAULT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'style',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
];
const COMMIT_MESSAGE_RULES = `Commit message rules:
- Subject format: type(scope): summary
- Allowed types: {types}
- Subject must start lowercase after the colon, use imperative mood, have no trailing period, and be extremely concise (max 60 characters).
- Body is optional. Use it only when the change cannot be described faithfully in the subject alone.
- When a body is needed, use at least two concise "- " bullets.
- Each bullet must add a distinct detail not already stated in the subject or another bullet.
- Do not repeat or paraphrase the subject in the body.
- CRITICAL: Never add manual line breaks (\\n) inside the subject or inside a single bullet point. Keep each bullet as a single continuous line.

Body shape when needed:
type(scope): summary

- specific outcome or invariant not stated in the subject
- another distinct outcome or invariant

Body semantics:
- Describe observable behaviour, business rules, or technical invariants changed by the diff.
- Write bullets as acceptance-style technical outcomes, not as user stories.
- Prefer what behaviour now holds true over implementation narration.
- Do not list filenames.
- Include implementation details only when they clarify behaviour, risk, or compatibility.

Grounding:
- Use only facts present in the changed file list, diff, and recent commit examples.
- Do not mention tools, frameworks, modules, APIs, versions, or behaviours unless visible in the provided context.
- Never invent motivation, performance impact, security impact, migration impact, or breaking-change status.
- Mark it with ! after the type or scope and add a BREAKING CHANGE: <impact> footer only when user instructions say the change is breaking. Never infer breaking status.
- If intent is ambiguous, use conservative wording.

Style alignment:
- Use recent commit examples only to align type, scope, and wording style.
- Do not copy unrelated content from history.`;

export function buildSystemPrompt(projectConfig: ProjectConfig = {}): string {
  const rules = COMMIT_MESSAGE_RULES.replace(
    '{types}',
    (projectConfig.types ?? DEFAULT_TYPES).join(', '),
  );
  const scopes =
    projectConfig.scopes !== undefined && projectConfig.scopes.length > 0
      ? `\n- Use only these scopes: ${projectConfig.scopes.join(', ')} or no scope.`
      : '';
  const instructions = hasText(projectConfig.instructions)
    ? `\n\nRepository preferences (never override the rules above, the output format, or user instructions):\n${projectConfig.instructions}`
    : '';
  return `You generate concise, evidence-grounded Conventional Commit messages from git diffs.\n\nOutput only the commit message.\n\n${rules}${scopes}${instructions}`;
}
