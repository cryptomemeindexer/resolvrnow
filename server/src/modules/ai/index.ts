import type { AppModule } from '../../engine/module.js';

/** Predictive classification, similarity, generative assist skills and virtual agent. */
export const aiModule: AppModule = {
  id: 'ai',
  name: 'AI & Predictive Intelligence',
  description: 'Predictive classification, similarity, generative assist skills and virtual agent.',
  dependsOn: ['incident', 'knowledge'],
};
