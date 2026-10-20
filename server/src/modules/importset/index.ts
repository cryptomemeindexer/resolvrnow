import type { AppModule } from '../../engine/module.js';
import type { AclDef } from '../../engine/services/acl.js';
import { IMPORT_SET_SERVICE, ImportSetService } from './service.js';
import { importSetTables } from './tables.js';

export {
  IMPORT_SET_SERVICE,
  ImportSetService,
  importSets,
  type TransformHook,
  type TransformResult,
} from './service.js';

const LOADERS = ['import_set_loader', 'import_transformer', 'import_admin'];
const ADMINS = ['import_admin'];

const acls: AclDef[] = [
  // Staging tables extend sys_import_set_row, so these rules cover every staging table.
  ...(['read', 'create', 'write'] as const).map((operation) => ({
    name: 'sys_import_set_row',
    operation,
    roles: LOADERS,
  })),
  { name: 'sys_import_set_row', operation: 'delete', roles: ADMINS },
  ...['sys_import_set', 'sys_multi_import_set'].flatMap((name) => [
    { name, operation: 'read' as const, roles: LOADERS },
    ...(['write', 'create', 'delete'] as const).map((operation) => ({ name, operation, roles: ADMINS })),
  ]),
  ...['sys_transform_map', 'sys_transform_entry', 'sys_rest_insert_multiple'].flatMap((name) => [
    { name, operation: 'read' as const, roles: LOADERS },
    ...(['write', 'create', 'delete'] as const).map((operation) => ({ name, operation, roles: ADMINS })),
  ]),
];

/** Import sets, staging tables, transform maps and the platform-compatible Import Set API engine. */
export const importSetModule: AppModule = {
  id: 'importset',
  name: 'Import Sets',
  description: 'Staging tables, import sets and transform maps used by the Import Set API.',
  dependsOn: ['platform'],
  tables: importSetTables,
  roles: [
    { name: 'import_set_loader', description: 'Loads rows into import set staging tables' },
    { name: 'import_transformer', description: 'Runs transforms of import sets' },
    {
      name: 'import_admin',
      description: 'Administers import sets and transform maps',
      contains: ['import_set_loader', 'import_transformer'],
    },
  ],
  acls,
  register(platform) {
    platform.services.set(IMPORT_SET_SERVICE, new ImportSetService(platform));
  },
  ui: {
    navigation: [
      {
        id: 'import_sets',
        title: 'System Import Sets',
        icon: 'file-input',
        roles: ['import_admin', 'admin'],
        order: 940,
        modules: [
          { title: 'Import Sets', table: 'sys_import_set', query: 'ORDERBYDESCsys_created_on' },
          { title: 'Transform Maps', table: 'sys_transform_map' },
          { title: 'Field Maps', table: 'sys_transform_entry' },
          { title: 'REST Insert Multiple', table: 'sys_rest_insert_multiple' },
        ],
      },
    ],
    lists: [
      {
        table: 'sys_import_set',
        columns: ['number', 'table_name', 'state', 'mode', 'row_count', 'sys_created_on'],
      },
      {
        table: 'sys_transform_map',
        columns: ['name', 'source_table', 'target_table', 'active', 'order', 'run_business_rules'],
      },
      {
        table: 'sys_transform_entry',
        columns: ['map', 'source_field', 'target_field', 'coalesce', 'choice_action'],
      },
    ],
  },
};
