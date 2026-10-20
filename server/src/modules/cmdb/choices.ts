import type { ChoiceDef } from '../../engine/types.js';

const c = (value: string, label: string, sequence: number, dependentValue?: string): ChoiceDef =>
  dependentValue === undefined ? { value, label, sequence } : { value, label, sequence, dependentValue };

/** Same list of values and labels, labels equal to values. */
const plain = (values: string[]): ChoiceDef[] => values.map((v, i) => c(v, v, i + 1));

export const CI_INSTALL_STATUS: ChoiceDef[] = [
  c('1', 'Installed', 1),
  c('2', 'On Order', 2),
  c('3', 'In Maintenance', 3),
  c('4', 'Pending Install', 4),
  c('5', 'Pending Repair', 5),
  c('6', 'In Stock', 6),
  c('7', 'Retired', 7),
  c('8', 'Stolen', 8),
  c('100', 'Absent', 9),
];

export const CI_OPERATIONAL_STATUS: ChoiceDef[] = [
  c('1', 'Operational', 1),
  c('2', 'Non-Operational', 2),
  c('3', 'Repair in Progress', 3),
  c('4', 'DR Standby', 4),
  c('5', 'Ready', 5),
  c('6', 'Retired', 6),
  c('7', 'Pipeline', 7),
  c('8', 'Catalog', 8),
];

/**
 * Discovery sources. The stored values are the platform's (clients send them as the
 * CMDB API `source`); the labels are ours.
 */
export const DISCOVERY_SOURCES: ChoiceDef[] = [
  c('ServiceNow', 'Discovery', 1),
  c('ManualEntry', 'Manual entry', 2),
  c('ImportSet', 'Import set', 3),
  c('EventManagement', 'Event management', 4),
  c('Tivoli', 'Tivoli', 5),
  c('SCCM', 'SCCM', 6),
  c('ServiceWatch', 'Service mapping', 7),
  c('Other Automated', 'Other automated', 8),
];

export const HARDWARE_STATUS: ChoiceDef[] = [
  c('installed', 'Installed', 10),
  c('on_order', 'On order', 20),
  c('in_stock', 'In stock', 30),
  c('in_transit', 'In transit', 40),
  c('in_maintenance', 'In maintenance', 50),
  c('retired', 'Retired', 60),
  c('missing', 'Missing', 70),
  c('build', 'Build', 80),
];

export const HARDWARE_SUBSTATUS: ChoiceDef[] = [
  c('in_use', 'In use', 10, 'installed'),
  c('available', 'Available', 10, 'in_stock'),
  c('reserved', 'Reserved', 20, 'in_stock'),
  c('pre_allocated', 'Pre-allocated', 30, 'in_stock'),
  c('defective', 'Defective', 40, 'in_stock'),
  c('pending_repair', 'Pending repair', 50, 'in_stock'),
  c('pending_install', 'Pending install', 60, 'in_stock'),
  c('pending_transfer', 'Pending transfer', 70, 'in_stock'),
  c('pending_disposal', 'Pending disposal', 80, 'in_stock'),
  c('disposed', 'Disposed', 10, 'retired'),
  c('sold', 'Sold', 20, 'retired'),
  c('donated', 'Donated', 30, 'retired'),
  c('vendor_credit', 'Vendor credit', 40, 'retired'),
  c('rma', 'RMA', 50, 'retired'),
  c('lease_return', 'Lease return', 60, 'retired'),
  c('buyout', 'Buyout', 70, 'retired'),
  c('lost', 'Lost', 10, 'missing'),
  c('stolen', 'Stolen', 20, 'missing'),
];

export const USED_FOR = plain([
  'Production',
  'Staging',
  'QA',
  'Test',
  'Development',
  'Demonstration',
  'Training',
  'Disaster Recovery',
]);
export const SERVER_CLASSIFICATION = plain(['Production', 'Development', 'Disaster recovery', 'UAT']);
export const FIREWALL_STATUS = plain(['Intranet', 'Internet']);
export const SERVICE_CLASSIFICATION = plain([
  'Business Service',
  'Application Service',
  'Technical Service',
  'Service Offering',
  'Shared Service',
  'Billable Service',
]);
export const BUSINESS_CRITICALITY = plain([
  '1 - most critical',
  '2 - somewhat critical',
  '3 - less critical',
  '4 - not critical',
]);
export const IP_VERSION: ChoiceDef[] = [c('4', 'IPv4', 1), c('6', 'IPv6', 2)];
export const VM_STATE: ChoiceDef[] = [
  c('on', 'On', 1),
  c('off', 'Off', 2),
  c('paused', 'Paused', 3),
  c('terminated', 'Terminated', 4),
  c('unknown', 'Unknown', 5),
];
export const CONNECTION_STRENGTH: ChoiceDef[] = [
  c('always', 'Always', 1),
  c('often', 'Often', 2),
  c('occasionally', 'Occasionally', 3),
  c('infrequently', 'Infrequently', 4),
];
export const SERIAL_NUMBER_TYPE: ChoiceDef[] = [
  c('system', 'System', 1),
  c('uuid', 'UUID', 2),
  c('chassis', 'Chassis', 3),
  c('bios', 'BIOS', 4),
  c('baseboard', 'Baseboard', 5),
];
export const HEALTH_METRIC: ChoiceDef[] = [
  c('required', 'Required', 1),
  c('recommended', 'Recommended', 2),
  c('orphan', 'Orphan', 3),
  c('staleness', 'Staleness', 4),
  c('duplicate', 'Duplicate', 5),
  c('audit', 'Audit', 6),
  c('rel_duplicate', 'Duplicate relationship', 7),
  c('rel_orphan', 'Orphan relationship', 8),
  c('rel_stale', 'Stale relationship', 9),
];
export const HEALTH_STATE: ChoiceDef[] = [c('pass', 'Pass', 1), c('fail', 'Fail', 2)];
export const ORPHAN_OPERATOR: ChoiceDef[] = [c('and', 'AND', 1), c('or', 'OR', 2)];
export const ASSET_TRACKING_STRATEGY: ChoiceDef[] = [
  c('leave_to_category', 'Leave to category', 10),
  c('track_as_consumable', 'Track as consumable', 20),
  c('do_not_track', 'Do not track', 30),
];
export const MODEL_STATUS = plain(['In Production', 'Retired', 'Sold', 'In Development']);
export const RECLASSIFICATION_TYPE: ChoiceDef[] = [
  c('upgrade', 'Upgrade', 1),
  c('downgrade', 'Downgrade', 2),
  c('switch', 'Switch', 3),
];
