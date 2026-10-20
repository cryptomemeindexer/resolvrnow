import type { AppModule } from '../../engine/module.js';

/** Knowledge bases, articles, versions, feedback and knowledge APIs. */
export const knowledgeModule: AppModule = {
  id: 'knowledge',
  name: 'Knowledge Management',
  description: 'Knowledge bases, articles, versions, feedback and knowledge APIs.',
  dependsOn: ['task'],
};
