import os from 'node:os';
import path from 'node:path';

// Points the general file at a path that does not exist, so a developer's own ~/.agents/subzero.yaml never reaches a test.
process.env.SUBZERO_GENERAL_CONFIG = path.join(os.tmpdir(), 'subzero-tests-no-general-config', 'subzero.yaml');
