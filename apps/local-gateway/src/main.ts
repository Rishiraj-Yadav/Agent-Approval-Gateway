/** Entry stub. Real composition wiring lands in Phase 2/3 — see docs/architecture.md §19. */
import { identity } from './index.js';

process.stdout.write(identity().join(' ') + '\n');
