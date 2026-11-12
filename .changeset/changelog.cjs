/**
 * Renders one Changeset as compact bullets without the commit hash; a hash
 * breaks when unpushed history is squashed.
 *
 * @param {{ summary: string }} changeset Released Changeset.
 * @returns {string} Release line.
 */
function getReleaseLine(changeset) {
  const lines = changeset.summary.trim().split('\n');
  const nextText = (index) =>
    lines.slice(index + 1).find((line) => line.trim() !== '') ?? '';
  const text = lines
    .filter(
      (line, index) => line.trim() !== '' || !nextText(index).startsWith('- '),
    )
    .join('\n');
  return text.startsWith('- ') ? text : `- ${text}`;
}

/**
 * Consumer benefits belong in reviewed Changesets, with explicit source
 * attribution.
 *
 * @returns {string} No dependency line.
 */
function getDependencyReleaseLine() {
  return '';
}

module.exports = { getReleaseLine, getDependencyReleaseLine };
