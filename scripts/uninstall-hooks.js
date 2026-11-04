// Removes only the Model Engine graph viewer hooks from the user's Claude settings.
// node scripts/uninstall-hooks.js [--dry-run] [--settings <path>]
require('./install-hooks.js').main('uninstall', process.argv.slice(2));
