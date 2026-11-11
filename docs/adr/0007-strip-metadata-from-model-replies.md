# 0007: Strip metadata from model replies everywhere after the subject

## Status

Accepted (2026-11-11, decided by the project owner)

## Context

The analysed diff is untrusted repository content, so the model reply derived
from it is untrusted too: a prompt injection can make the model write lines
that other tools act on. Hosting services close issues from closing keywords
anywhere in a commit message, and mail-based workflows read `Cc:` trailers.

An earlier change kept `Cc:` lines as prose and kept closing-keyword lines
inside a `BREAKING CHANGE` block, while README documented the opposite. A later
audit reversed the code to match README. Both directions passed the test suite
at the time, because nothing tied README to the parser.

## Decision

After the subject line, the parser drops:

- every line that starts with a denylisted trailer, `Cc:` included;
- every line that contains a closing keyword with an issue reference, also
  inside a `BREAKING CHANGE` block;
- CI skip markers anywhere in the reply.

`BREAKING CHANGE:` footers and other prose are kept. The subject line is not
filtered.

README is the contract. `test/readme-contract.test.ts` checks that every
trailer, closing-keyword example and CI marker README lists is removed by the
parser, so README and code cannot drift apart silently.

## Consequences

- Legitimate prose in a breaking-change note such as `fixes #3 no longer works`
  is dropped. Users who need it add it while reviewing the message.
- Changing the denylist means changing README and the parser in the same
  commit; the contract test fails otherwise.
- Reversing this decision needs a new ADR, not only a code change.
