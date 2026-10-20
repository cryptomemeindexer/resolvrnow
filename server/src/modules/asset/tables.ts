import type { ChoiceDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';
import {
  bool,
  cls,
  col,
  date,
  dt,
  int,
  ref,
  str,
  strChoice,
  tableName,
  withoutScripts,
} from '../cmdb/columns.js';

const c = (value: string, label: string, sequence: number, dependentValue?: string): ChoiceDef =>
  dependentValue === undefined ? { value, label, sequence } : { value, label, sequence, dependentValue };

export const ASSET_STATE_CHOICES: ChoiceDef[] = [
  c('1', 'In use', 10),
  c('2', 'On order', 20),
  c('3', 'In maintenance', 30),
  c('6', 'In stock', 40),
  c('7', 'Retired', 50),
  c('8', 'Missing', 60),
  c('9', 'In transit', 70),
  c('10', 'Consumed', 80),
  c('11', 'Build', 90),
];

export const ASSET_SUBSTATE_CHOICES: ChoiceDef[] = [
  c('available', 'Available', 10, '6'),
  c('reserved', 'Reserved', 20, '6'),
  c('pre_allocated', 'Pre-allocated', 30, '6'),
  c('defective', 'Defective', 40, '6'),
  c('pending_repair', 'Pending repair', 50, '6'),
  c('pending_install', 'Pending install', 60, '6'),
  c('pending_transfer', 'Pending transfer', 70, '6'),
  c('pending_disposal', 'Pending disposal', 80, '6'),
  c('disposed', 'Disposed', 10, '7'),
  c('sold', 'Sold', 20, '7'),
  c('donated', 'Donated', 30, '7'),
  c('vendor_credit', 'Vendor credit', 40, '7'),
  c('rma', 'RMA', 50, '7'),
  c('lease_return', 'Lease return', 60, '7'),
  c('buyout', 'Buyout', 70, '7'),
  c('lost', 'Lost', 10, '8'),
  c('stolen', 'Stolen', 20, '8'),
];

export const CONTRACT_STATE_CHOICES: ChoiceDef[] = [
  c('draft', 'Draft', 10),
  c('active', 'Active', 20),
  c('expired', 'Expired', 30),
  c('cancelled', 'Cancelled', 40),
];
export const CONTRACT_SUBSTATE_CHOICES: ChoiceDef[] = [
  c('awaiting_review', 'Awaiting review', 10, 'draft'),
  c('under_review', 'Under review', 20, 'draft'),
  c('approved', 'Approved', 30, 'draft'),
];
const RESTOCKING: ChoiceDef[] = [c('stockroom', 'Stockroom', 10), c('vendor', 'Vendor', 20)];
const TRANSFER_STAGE: ChoiceDef[] = [
  c('draft', 'Draft', 10),
  c('requested', 'Requested', 20),
  c('in_transit', 'In transit', 30),
  c('received', 'Received', 40),
  c('cancelled', 'Cancelled', 50),
];

const assetClassTables: TableDef[] = [
  withoutScripts(
    sdkTable('alm_asset', {
      displayField: 'display_name',
      audit: true,
      extensible: true,
      textIndex: ['display_name', 'asset_tag', 'serial_number'],
      patch: {
        install_status: {
          choices: ASSET_STATE_CHOICES,
          defaultValue: '1',
          choiceMode: 'dropdown_without_none',
        },
        substatus: { choices: ASSET_SUBSTATE_CHOICES, maxLength: 40 },
        ci: { cascade: 'clear', indexed: true },
        model: { cascade: 'restrict' },
        model_category: { cascade: 'restrict' },
        asset_tag: { indexed: true },
        serial_number: { indexed: true },
        display_name: { readOnly: true },
        old_status: { readOnly: true },
        old_substatus: { readOnly: true },
      },
    }),
  ),
  sdkTable('alm_hardware', { audit: true }),
  cls('alm_consumable', 'Consumable', 'alm_asset'),
  cls('alm_license', 'Software License', 'alm_asset'),
  cls('alm_facility', 'Facility', 'alm_asset'),
  {
    name: 'cmdb_model_category',
    label: 'Model Category',
    plural: 'Model Categories',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      tableName('asset_class', 'Asset class', {
        hint: 'Asset table created for models of this category; empty means no asset',
      }),
      tableName('cmdb_ci_class', 'CI class', {
        hint: 'CI class created for assets of this category; empty means no CI',
      }),
      bool('enforce_verification', 'Enforce CI verification'),
      bool('allow_as_master', 'Allow as bundle parent'),
      bool('allow_in_bundle', 'Allow in bundle', true),
      bool('product_instance', 'Product instance'),
    ],
  },
];

const stockTables: TableDef[] = [
  {
    name: 'alm_stockroom_type',
    label: 'Stockroom Type',
    displayField: 'name',
    columns: [str('name', 'Name', 100, { mandatory: true }), str('description', 'Description', 1000)],
  },
  {
    name: 'alm_stockroom',
    label: 'Stockroom',
    displayField: 'name',
    audit: true,
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      ref('type', 'Type', 'alm_stockroom_type'),
      ref('location', 'Location', 'cmn_location', { mandatory: true }),
      ref('manager', 'Manager', 'sys_user'),
      ref('assignment_group', 'Assignment group', 'sys_user_group'),
      ref('company', 'Company', 'core_company'),
      bool('external', 'External'),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'alm_stock_rule',
    label: 'Stock Rule',
    displayField: 'model',
    columns: [
      ref('stockroom', 'Stockroom', 'alm_stockroom', { mandatory: true, cascade: 'delete' }),
      ref('model', 'Model', 'cmdb_model', { mandatory: true }),
      int('threshold', 'Threshold', { defaultValue: '0' }),
      strChoice('restocking_option', 'Restocking option', RESTOCKING, { defaultValue: 'stockroom' }),
      ref('parent_stockroom', 'Parent stockroom', 'alm_stockroom'),
      int('order_size', 'Order size', { defaultValue: '1' }),
      bool('active', 'Active', true),
      bool('breach_active', 'Breach active', false, { readOnly: true, internal: true }),
    ],
  },
  {
    name: 'alm_transfer_order',
    label: 'Transfer Order',
    number: { prefix: 'TRO', start: 1000 },
    audit: true,
    columns: [
      str('number', 'Number', 40, { readOnly: true }),
      ref('from_stockroom', 'From stockroom', 'alm_stockroom'),
      ref('to_stockroom', 'To stockroom', 'alm_stockroom', { mandatory: true }),
      strChoice('stage', 'Stage', TRANSFER_STAGE, { defaultValue: 'draft' }),
      dt('ship_date', 'Ship date'),
      dt('received_date', 'Received date'),
    ],
  },
  {
    name: 'alm_transfer_order_line',
    label: 'Transfer Order Line',
    displayField: 'asset',
    columns: [
      ref('transfer_order', 'Transfer order', 'alm_transfer_order', { mandatory: true, cascade: 'delete' }),
      ref('asset', 'Asset', 'alm_asset'),
      ref('model', 'Model', 'cmdb_model'),
      int('quantity_requested', 'Quantity requested', { defaultValue: '1' }),
      strChoice('stage', 'Stage', TRANSFER_STAGE, { defaultValue: 'draft' }),
    ],
  },
];

const contractTables: TableDef[] = [
  withoutScripts(
    sdkTable('ast_contract', {
      displayField: 'number',
      audit: true,
      extensible: true,
      textIndex: ['number', 'short_description', 'vendor_contract'],
      patch: {
        state: { choices: CONTRACT_STATE_CHOICES, maxLength: 40 },
        substate: { choices: CONTRACT_SUBSTATE_CHOICES, maxLength: 40 },
        contract_model: { referenceQual: 'sys_class_name=cmdb_contract_product_model' },
        number: { readOnly: true, indexed: true },
      },
      columns: [
        bool('expiration_notified', 'Expiration notified', false, { readOnly: true }),
        col('work_notes', 'Work notes', 'journal_input'),
      ],
    }),
  ),
  cls('ast_lease', 'Lease', 'ast_contract'),
  cls('ast_warranty', 'Warranty', 'ast_contract'),
  cls('ast_service', 'Service Contract', 'ast_contract'),
  {
    name: 'clm_m2m_contract_asset',
    label: 'Asset Covered',
    plural: 'Assets Covered',
    displayField: 'asset',
    columns: [
      ref('contract', 'Contract', 'ast_contract', { mandatory: true, cascade: 'delete' }),
      ref('asset', 'Asset', 'alm_asset', { mandatory: true, cascade: 'delete' }),
      date('added', 'Added'),
      date('removed', 'Removed'),
    ],
    indexes: [['contract', 'asset']],
  },
];

const mappingTables: TableDef[] = [
  {
    name: 'alm_asset_ci_state_mapping',
    label: 'Asset CI Install Status Mapping',
    displayField: 'asset_state',
    columns: [
      col('asset_state', 'Asset state', 'integer', { choices: ASSET_STATE_CHOICES }),
      str('asset_substatus', 'Asset substate', 40, { hint: 'Empty matches any substate' }),
      int('ci_install_status', 'CI status'),
      bool('reverse', 'Reverse'),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'alm_hardware_state_mapping',
    label: 'Asset CI Hardware Status Mapping',
    displayField: 'asset_state',
    columns: [
      col('asset_state', 'Asset state', 'integer', { choices: ASSET_STATE_CHOICES }),
      str('asset_substatus', 'Asset substate', 40, { hint: 'Empty matches any substate' }),
      str('hardware_status', 'Hardware status', 40),
      str('hardware_substatus', 'Hardware substatus', 40),
      bool('reverse', 'Reverse'),
      bool('active', 'Active', true),
    ],
  },
];

export const assetTables: TableDef[] = [
  ...assetClassTables,
  ...stockTables,
  ...contractTables,
  ...mappingTables,
];
