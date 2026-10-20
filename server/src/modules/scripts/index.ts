import type { AppModule } from '../../engine/module.js';

/** Sandboxed server-side scripting (GlideRecord-compatible API), business rule scripts, script includes, background scripts. */
export const scriptsModule: AppModule = {
  id: 'scripts',
  name: 'Scripting',
  description: 'Sandboxed server-side scripting (GlideRecord-compatible API), business rule scripts, script includes, background scripts.',
  dependsOn: ['platform'],
};
