import type { FormLayoutDef, ListLayoutDef, ModuleUiDef } from '../../engine/module.js';
import { contractActions } from './contracts.js';

const assetSections = [
  {
    left: ['display_name', 'asset_tag', 'serial_number', 'model_category', 'model', 'ci'],
    right: [
      'install_status',
      'substatus',
      'assigned_to',
      'assigned',
      'location',
      'stockroom',
      'reserved_for',
    ],
  },
  {
    caption: 'Ownership',
    left: ['company', 'department', 'cost_center', 'owned_by'],
    right: ['managed_by', 'support_group', 'supported_by', 'vendor'],
  },
  {
    caption: 'Financial',
    left: ['cost', 'po_number', 'invoice_number', 'purchase_date'],
    right: ['order_date', 'delivery_date', 'lease_id', 'warranty_expiration'],
  },
  {
    caption: 'Lifecycle',
    left: ['install_date', 'retired', 'retirement_date', 'disposal_reason'],
    right: ['old_status', 'old_substatus', 'life_cycle_stage', 'life_cycle_stage_status'],
  },
  { caption: 'Notes', fields: ['comments', 'work_notes'] },
];

const assetRelated = [
  {
    table: 'clm_m2m_contract_asset',
    field: 'asset',
    label: 'Contracts',
    columns: ['contract', 'contract.short_description', 'contract.ends', 'added', 'removed'],
  },
  {
    table: 'alm_transfer_order_line',
    field: 'asset',
    label: 'Transfer order lines',
    columns: ['transfer_order', 'stage', 'quantity_requested'],
  },
];

const forms: FormLayoutDef[] = [
  {
    table: 'alm_asset',
    highlights: ['install_status', 'substatus', 'assigned_to'],
    sections: assetSections,
    relatedLists: assetRelated,
  },
  {
    table: 'alm_hardware',
    highlights: ['install_status', 'substatus', 'assigned_to'],
    sections: [
      assetSections[0],
      { caption: 'Hardware', left: ['eligible_for_refresh'], right: ['quantity'] },
      ...assetSections.slice(1),
    ],
    relatedLists: assetRelated,
  },
  {
    table: 'cmdb_model',
    sections: [
      {
        left: ['name', 'display_name', 'manufacturer', 'model_number', 'sys_class_name'],
        right: ['status', 'cmdb_model_category', 'asset_tracking_strategy', 'cmdb_ci_class', 'cost'],
      },
      { fields: ['short_description', 'description'] },
    ],
    relatedLists: [
      {
        table: 'alm_asset',
        field: 'model',
        label: 'Assets',
        columns: ['display_name', 'install_status', 'substatus', 'assigned_to', 'location'],
      },
      {
        table: 'cmdb_ci',
        field: 'model_id',
        label: 'Configuration items',
        columns: ['name', 'sys_class_name', 'install_status', 'location'],
      },
    ],
  },
  {
    table: 'cmdb_model_category',
    sections: [
      {
        left: ['name', 'asset_class', 'cmdb_ci_class'],
        right: ['enforce_verification', 'allow_as_master', 'allow_in_bundle', 'product_instance'],
      },
    ],
    relatedLists: [
      {
        table: 'alm_asset',
        field: 'model_category',
        label: 'Assets',
        columns: ['display_name', 'install_status', 'assigned_to'],
      },
    ],
  },
  {
    table: 'alm_stockroom',
    sections: [
      {
        left: ['name', 'type', 'location', 'company'],
        right: ['manager', 'assignment_group', 'external', 'active'],
      },
    ],
    relatedLists: [
      {
        table: 'alm_asset',
        field: 'stockroom',
        label: 'Assets in stock',
        columns: ['display_name', 'model', 'install_status', 'substatus', 'reserved_for'],
      },
      {
        table: 'alm_stock_rule',
        field: 'stockroom',
        label: 'Stock rules',
        columns: ['model', 'threshold', 'restocking_option', 'active'],
      },
    ],
  },
  {
    table: 'alm_stock_rule',
    sections: [
      {
        left: ['stockroom', 'model', 'threshold'],
        right: ['restocking_option', 'parent_stockroom', 'order_size', 'active'],
      },
    ],
  },
  {
    table: 'alm_transfer_order',
    sections: [
      { left: ['number', 'from_stockroom', 'to_stockroom'], right: ['stage', 'ship_date', 'received_date'] },
    ],
    relatedLists: [
      {
        table: 'alm_transfer_order_line',
        field: 'transfer_order',
        label: 'Lines',
        columns: ['asset', 'model', 'quantity_requested', 'stage'],
      },
    ],
  },
  {
    table: 'ast_contract',
    highlights: ['state', 'substate', 'ends'],
    sections: [
      {
        left: [
          'number',
          'short_description',
          'sys_class_name',
          'contract_model',
          'vendor',
          'vendor_contract',
        ],
        right: ['state', 'substate', 'starts', 'ends', 'renewable', 'active'],
      },
      {
        caption: 'Renewal',
        left: ['renewal_date', 'renewal_end_date', 'notice_date'],
        right: ['renewal_notice_period', 'termination_notice_days', 'expiration_notified'],
      },
      {
        caption: 'Administration',
        left: ['contract_administrator', 'approver', 'business_owner'],
        right: ['cost_center', 'monthly_cost', 'yearly_cost', 'total_cost'],
      },
      { fields: ['description', 'terms_and_conditions'] },
      { caption: 'Notes', fields: ['work_notes'] },
    ],
    relatedLists: [
      {
        table: 'clm_m2m_contract_asset',
        field: 'contract',
        label: 'Assets covered',
        columns: ['asset', 'asset.install_status', 'added', 'removed'],
      },
      {
        table: 'ast_contract',
        field: 'parent_contract',
        label: 'Child contracts',
        columns: ['number', 'short_description', 'state', 'ends'],
      },
    ],
  },
];

const lists: ListLayoutDef[] = [
  {
    table: 'alm_asset',
    columns: [
      'display_name',
      'sys_class_name',
      'install_status',
      'substatus',
      'assigned_to',
      'location',
      'stockroom',
    ],
    defaultOrder: 'display_name',
  },
  {
    table: 'alm_hardware',
    columns: [
      'display_name',
      'serial_number',
      'install_status',
      'substatus',
      'assigned_to',
      'location',
      'warranty_expiration',
    ],
    defaultOrder: 'display_name',
  },
  {
    table: 'cmdb_model_category',
    columns: ['name', 'asset_class', 'cmdb_ci_class', 'enforce_verification'],
    defaultOrder: 'name',
  },
  {
    table: 'alm_stockroom',
    columns: ['name', 'type', 'location', 'manager', 'active'],
    defaultOrder: 'name',
  },
  { table: 'alm_stock_rule', columns: ['stockroom', 'model', 'threshold', 'restocking_option', 'active'] },
  {
    table: 'alm_transfer_order',
    columns: ['number', 'from_stockroom', 'to_stockroom', 'stage', 'ship_date', 'received_date'],
  },
  {
    table: 'ast_contract',
    columns: ['number', 'short_description', 'sys_class_name', 'vendor', 'state', 'starts', 'ends'],
    defaultOrder: 'ends',
  },
  { table: 'clm_m2m_contract_asset', columns: ['contract', 'asset', 'added', 'removed'] },
];

export const assetUi: ModuleUiDef = {
  navigation: [
    {
      id: 'asset',
      title: 'Asset Management',
      icon: 'package',
      roles: ['asset', 'itil'],
      order: 65,
      modules: [
        { title: 'All Assets', table: 'alm_asset', query: 'ORDERBYdisplay_name' },
        { title: 'Hardware', table: 'alm_hardware', query: 'ORDERBYdisplay_name' },
        { title: 'In Stock', table: 'alm_hardware', query: 'install_status=6^ORDERBYstockroom' },
        { title: 'In Use', table: 'alm_hardware', query: 'install_status=1^ORDERBYassigned_to' },
        { title: 'Retired', table: 'alm_asset', query: 'install_status=7^ORDERBYDESCretired' },
        { title: 'Consumables', table: 'alm_consumable' },
        { title: 'Software Licenses', table: 'alm_license' },
        { title: 'Stockrooms', table: 'alm_stockroom', separator: true },
        { title: 'Stock Rules', table: 'alm_stock_rule' },
        { title: 'Transfer Orders', table: 'alm_transfer_order', query: 'ORDERBYDESCnumber' },
        { title: 'Product Models', table: 'cmdb_model', query: 'ORDERBYdisplay_name', separator: true },
        { title: 'Model Categories', table: 'cmdb_model_category' },
        { title: 'Contracts', table: 'ast_contract', query: 'ORDERBYends', separator: true },
        { title: 'Active Contracts', table: 'ast_contract', query: 'state=active^ORDERBYends' },
      ],
    },
  ],
  forms,
  lists,
  uiActions: [
    {
      id: 'asset.deploy',
      table: 'alm_asset',
      label: 'Deploy',
      style: 'primary',
      roles: ['asset'],
      condition: 'install_status=6',
      prompt: [{ field: 'assigned_to', mandatory: true }],
      run(rec, ctx, input) {
        ctx.update(rec, { install_status: 1, assigned_to: input.assigned_to });
        return { message: 'Asset deployed' };
      },
    },
    {
      id: 'asset.retire',
      table: 'alm_asset',
      label: 'Retire',
      style: 'destructive',
      roles: ['asset'],
      condition: 'install_status!=7',
      prompt: [{ field: 'disposal_reason', mandatory: true }],
      confirm: 'Retire this asset? Its configuration item is retired as well.',
      run(rec, ctx, input) {
        ctx.update(rec, { install_status: 7, substatus: 'disposed', disposal_reason: input.disposal_reason });
        return { message: 'Asset retired' };
      },
    },
    ...contractActions,
  ],
};
