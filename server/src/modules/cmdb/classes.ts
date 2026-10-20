/**
 * Hand-written CI classes (cmdb.md section 2). Every class below `cmdb` is stored in the
 * `cmdb` SQL table and told apart by sys_class_name.
 */
import type { TableDef } from '../../engine/types.js';
import {
  FIREWALL_STATUS,
  HARDWARE_STATUS,
  HARDWARE_SUBSTATUS,
  IP_VERSION,
  SERVER_CLASSIFICATION,
  USED_FOR,
  VM_STATE,
} from './choices.js';
import { bool, choice, cls, dec, int, ref, str, strChoice } from './columns.js';

const hardware: TableDef[] = [
  cls('cmdb_ci_hardware', 'Hardware', 'cmdb_ci', [
    choice('hardware_status', 'Hardware Status', HARDWARE_STATUS, {
      hint: 'Kept in step with the linked asset State',
    }),
    choice('hardware_substatus', 'Hardware Substatus', HARDWARE_SUBSTATUS, {
      dependentOn: 'hardware_status',
    }),
    str('default_gateway', 'Default Gateway'),
  ]),
  cls('cmdb_ci_computer', 'Computer', 'cmdb_ci_hardware', [
    str('os', 'Operating System', 100),
    str('os_version', 'OS Version', 100),
    str('os_service_pack', 'OS Service Pack', 100),
    int('os_address_width', 'OS Address Width (bits)'),
    str('os_domain', 'OS Domain'),
    int('cpu_count', 'CPU count'),
    int('cpu_core_count', 'CPU core count'),
    int('cpu_core_thread', 'CPU core thread'),
    str('cpu_name', 'CPU name', 100),
    int('cpu_speed', 'CPU speed (MHz)'),
    str('cpu_type', 'CPU type', 100),
    ref('cpu_manufacturer', 'CPU manufacturer', 'core_company'),
    int('ram', 'RAM (MB)'),
    dec('disk_space', 'Disk space (GB)'),
    bool('virtual', 'Is Virtual'),
    str('form_factor', 'Form factor', 40),
    str('chassis_type', 'Chassis type', 40),
    bool('cd_rom', 'CD ROM'),
    int('cd_speed', 'CD Speed'),
    str('floppy', 'Floppy', 40),
    str('object_id', 'Object ID'),
  ]),
  cls('cmdb_ci_pc_hardware', 'Personal Computer', 'cmdb_ci_computer'),
  cls('cmdb_ci_server', 'Server', 'cmdb_ci_computer', [
    strChoice('classification', 'Classification', SERVER_CLASSIFICATION, { defaultValue: 'Production' }),
    strChoice('firewall_status', 'Firewall status', FIREWALL_STATUS),
    str('host_name', 'Host name'),
    strChoice('used_for', 'Used for', USED_FOR, { defaultValue: 'Production' }),
    ref('dr_backup', 'DR backup', 'cmdb_ci_server'),
    bool('internet_facing', 'Internet facing'),
  ]),
  cls('cmdb_ci_linux_server', 'Linux Server', 'cmdb_ci_server', [
    str('kernel_release', 'Kernel release', 100),
  ]),
  cls('cmdb_ci_win_server', 'Windows Server', 'cmdb_ci_server'),
  cls('cmdb_ci_unix_server', 'UNIX Server', 'cmdb_ci_server'),
  cls('cmdb_ci_solaris_server', 'Solaris Server', 'cmdb_ci_unix_server'),
  cls('cmdb_ci_aix_server', 'AIX Server', 'cmdb_ci_unix_server'),
  cls('cmdb_ci_hpux_server', 'HPUX Server', 'cmdb_ci_unix_server'),
  cls('cmdb_ci_virtualization_server', 'Virtualization Server', 'cmdb_ci_server'),
  cls('cmdb_ci_esx_server', 'ESX Server', 'cmdb_ci_virtualization_server'),
  cls('cmdb_ci_mainframe', 'IBM Mainframe', 'cmdb_ci_server'),
  cls('cmdb_ci_lb', 'Load Balancer', 'cmdb_ci_server'),
  cls('cmdb_ci_storage_switch', 'Storage Switch', 'cmdb_ci_computer'),
  cls('cmdb_ci_netgear', 'Network Gear', 'cmdb_ci_hardware', [
    int('ports', 'Ports'),
    bool('can_route', 'Can route'),
    bool('can_switch', 'Can switch'),
    str('firmware_version', 'Firmware version', 100),
  ]),
  cls('cmdb_ci_ip_router', 'IP Router', 'cmdb_ci_netgear'),
  cls('cmdb_ci_ip_switch', 'IP Switch', 'cmdb_ci_netgear'),
  cls('cmdb_ci_ip_firewall', 'IP Firewall', 'cmdb_ci_netgear'),
  cls('cmdb_ci_wap_network', 'Wireless Access Point', 'cmdb_ci_netgear'),
  cls('cmdb_ci_network_adapter', 'Network Adapter', 'cmdb_ci_hardware', [
    ref('cmdb_ci', 'Configuration item', 'cmdb_ci'),
  ]),
  cls('cmdb_ci_storage_device', 'Storage Device', 'cmdb_ci_hardware', [dec('size_bytes', 'Size (bytes)')]),
  cls('cmdb_ci_disk', 'Disk', 'cmdb_ci_storage_device'),
  cls('cmdb_ci_san', 'Storage Area Network', 'cmdb_ci_storage_device'),
  cls('cmdb_ci_rack', 'Rack', 'cmdb_ci_hardware'),
  cls('cmdb_ci_peripheral', 'Computer Peripheral', 'cmdb_ci_hardware'),
  cls('cmdb_ci_printer', 'Printer', 'cmdb_ci_hardware'),
];

const logical: TableDef[] = [
  cls('cmdb_ci_storage_volume', 'Storage Volume', 'cmdb_ci'),
  cls('cmdb_ci_storage_pool', 'Storage Pool', 'cmdb_ci'),
  cls('cmdb_ci_file_system', 'File System', 'cmdb_ci'),
  cls('cmdb_ci_ip_address', 'IP Address', 'cmdb_ci', [
    str('netmask', 'Netmask', 40),
    strChoice('ip_version', 'IP version', IP_VERSION),
    ref('nic', 'Network adapter', 'cmdb_ci_network_adapter'),
  ]),
  cls('cmdb_ci_vm_instance', 'Virtual Machine Instance', 'cmdb_ci', [
    str('object_id', 'Object ID'),
    int('cpus', 'CPUs'),
    int('memory', 'Memory (MB)'),
    strChoice('state', 'State', VM_STATE),
  ]),
  cls('cmdb_ci_vmware_instance', 'VMware Virtual Machine Instance', 'cmdb_ci_vm_instance'),
  cls('cmdb_ci_hyper_v_instance', 'Hyper-V Virtual Machine Instance', 'cmdb_ci_vm_instance'),
  cls('cmdb_ci_cluster', 'Cluster', 'cmdb_ci', [str('cluster_status', 'Cluster status', 40)]),
  cls('cmdb_ci_win_cluster', 'Windows Cluster', 'cmdb_ci_cluster'),
  cls('cmdb_ci_unix_cluster', 'UNIX Cluster', 'cmdb_ci_cluster'),
  cls('cmdb_ci_cluster_node', 'Cluster Node', 'cmdb_ci', [
    ref('cluster', 'Cluster', 'cmdb_ci_cluster'),
    ref('server', 'Server', 'cmdb_ci_server'),
  ]),
  cls('cmdb_ci_database', 'Database', 'cmdb_ci', [str('type', 'Type', 40), str('version', 'Version', 100)]),
  cls('cmdb_ci_spkg', 'Software', 'cmdb_ci', [str('version', 'Version', 100)]),
  cls('cmdb_ci_endpoint', 'Endpoint', 'cmdb_ci'),
  cls('cmdb_ci_qualifier', 'Qualifier', 'cmdb_ci'),
  cls('cmdb_ci_business_capability', 'Business Capability', 'cmdb_ci'),
  cls('cmdb_ci_information_object', 'Information Object', 'cmdb_ci'),
  cls('cmdb_ci_business_process', 'Business Process', 'cmdb_ci'),
];

const applications: TableDef[] = [
  cls('cmdb_ci_appl', 'Application', 'cmdb_ci', [
    str('version', 'Version', 100),
    str('edition', 'Edition', 100),
    str('install_directory', 'Install directory'),
    str('config_directory', 'Configuration directory'),
    str('tcp_port', 'TCP port(s)'),
    str('running_process', 'Running process', 4000),
    strChoice('used_for', 'Used for', USED_FOR),
  ]),
  cls('cmdb_ci_appl_dot_net', '.NET Application', 'cmdb_ci_appl'),
  cls('cmdb_ci_db_instance', 'Database Instance', 'cmdb_ci_appl', [str('instance_name', 'Instance name')]),
  cls('cmdb_ci_db_ora_instance', 'Oracle Instance', 'cmdb_ci_db_instance'),
  cls('cmdb_ci_db_mssql_instance', 'MSFT SQL Instance', 'cmdb_ci_db_instance'),
  cls('cmdb_ci_db_mysql_instance', 'MySQL Instance', 'cmdb_ci_db_instance'),
  cls('cmdb_ci_db_postgresql_instance', 'PostgreSQL Instance', 'cmdb_ci_db_instance'),
  cls('cmdb_ci_app_server', 'Application Server', 'cmdb_ci_appl'),
  cls('cmdb_ci_app_server_tomcat', 'Tomcat', 'cmdb_ci_app_server'),
  cls('cmdb_ci_app_server_jboss', 'JBoss', 'cmdb_ci_app_server'),
  cls('cmdb_ci_app_server_weblogic', 'BEA Weblogic', 'cmdb_ci_app_server'),
  cls('cmdb_ci_app_server_websphere', 'IBM Websphere', 'cmdb_ci_app_server'),
  cls('cmdb_ci_app_server_tomcat_war', 'Tomcat WAR', 'cmdb_ci'),
  cls('cmdb_ci_web_server', 'Web Server', 'cmdb_ci_appl'),
  cls('cmdb_ci_apache_web_server', 'Apache Web Server', 'cmdb_ci_web_server'),
  cls('cmdb_ci_nginx_web_server', 'Nginx Web Server', 'cmdb_ci_web_server'),
  cls('cmdb_ci_iis_web_server', 'IIS Web Server', 'cmdb_ci_web_server'),
];

const services: TableDef[] = [
  cls('cmdb_ci_service_business', 'Business Service', 'cmdb_ci_service'),
  cls('cmdb_ci_service_technical', 'Technology Management Service', 'cmdb_ci_service'),
  cls('cmdb_ci_service_auto', 'Service Instance', 'cmdb_ci_service'),
  cls('cmdb_ci_service_discovered', 'Mapped Application Service', 'cmdb_ci_service_auto'),
  cls('cmdb_ci_query_based_service', 'Dynamic CI Group', 'cmdb_ci_service_auto', [
    ref('cmdb_group', 'CMDB group', 'cmdb_group'),
  ]),
  cls('cmdb_ci_service_by_tags', 'Tag-based Service Instance', 'cmdb_ci_service_auto'),
];

export const ciClasses: TableDef[] = [...hardware, ...logical, ...applications, ...services];
