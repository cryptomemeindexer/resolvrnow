import type { AppModule } from '../../engine/module.js';

/** Problems, problem tasks, known errors and workarounds. */
export const problemModule: AppModule = {
  id: 'problem',
  name: 'Problem Management',
  description: 'Problems, problem tasks, known errors and workarounds.',
  dependsOn: ['incident'],
};
