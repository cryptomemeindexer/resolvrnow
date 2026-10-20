// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fulfillment step templates use ${variable} placeholders
/**
 * Demo catalog for the fictional company Northwind Labs: an IT catalog with five
 * categories, 14 items (including an order guide and a record producer), fulfillment
 * steps for the demo groups, and about twenty requests in different stages.
 */
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { clock } from '../../engine/util.js';
import { type ApprovalService, optionalService, SERVICES } from '../contracts.js';
import { DEMO_PASSWORD } from '../platform/demo.js';
import { PROP, STAGE, STATE, T, VT } from './constants.js';
import { fulfillmentOf } from './fulfillment.js';
import { evaluateGuide, orderGuide } from './guide.js';
import { orderNow } from './ordering.js';
import { submitProducer } from './producer.js';

const DAY = 86_400_000;

interface VarSpec {
  name: string;
  q: string;
  type: number;
  mandatory?: boolean;
  /** [value, label, price?, recurring price?] */
  choices?: [string, string, number?, number?][];
  ref?: string;
  refQual?: string;
  regex?: string;
  example?: string;
  help?: string;
  def?: string;
  ifChecked?: number;
  pricing?: boolean;
  choiceTable?: string;
  choiceField?: string;
  also?: boolean;
  hidden?: boolean;
  attributes?: string;
}

interface StepSpec {
  order: number;
  name: string;
  sd: string;
  group: string;
  stage?: 'delivery';
  description?: string;
}

interface ItemSpec {
  key: string;
  name: string;
  short: string;
  description: string;
  category?: string;
  icon: string;
  price?: number;
  recurring?: number;
  frequency?: string;
  group?: string;
  manager?: boolean;
  approvalGroups?: string[];
  deliveryDays?: number;
  vars: VarSpec[];
  requesterSet?: boolean;
  steps?: StepSpec[];
  automation?: string;
  meta?: string;
  availableFor?: string[];
  order: number;
  noQuantity?: boolean;
}

const ITEMS: ItemSpec[] = [
  {
    key: 'laptop',
    name: 'Standard Laptop',
    short: 'A company laptop with your choice of model and memory.',
    description:
      '<p>Every Northwind Labs laptop ships encrypted, enrolled in device management and loaded with the standard software bundle.</p><p>Pick the model that fits your work. Engineers and designers usually choose 32 GB of memory.</p>',
    category: 'Hardware',
    icon: 'laptop',
    price: 1150,
    group: 'Hardware Support',
    manager: true,
    deliveryDays: 5,
    requesterSet: true,
    meta: 'computer, notebook, macbook, thinkpad, latitude',
    order: 100,
    noQuantity: true,
    vars: [
      {
        name: 'model',
        q: 'Model',
        type: VT.select,
        mandatory: true,
        choices: [
          ['latitude_14', 'Dell Latitude 14', 0],
          ['thinkpad_14', 'Lenovo ThinkPad 14', 0],
          ['macbook_pro_14', 'Apple MacBook Pro 14', 450],
        ],
      },
      {
        name: 'ram',
        q: 'Memory',
        type: VT.multipleChoice,
        def: '16gb',
        choices: [
          ['16gb', '16 GB', 0],
          ['32gb', '32 GB', 180],
          ['64gb', '64 GB', 420],
        ],
      },
      { name: 'extended_warranty', q: 'Add a 3-year extended warranty', type: VT.checkbox, ifChecked: 129 },
      {
        name: 'justification',
        q: 'Business justification',
        type: VT.multiLine,
        mandatory: true,
        help: 'Tell us whether this is a new hire, a replacement or an upgrade.',
      },
      {
        name: 'delivery_location',
        q: 'Deliver to',
        type: VT.reference,
        ref: 'cmn_location',
        help: 'Leave empty to collect it at the IT bar of your office.',
      },
    ],
    steps: [
      {
        order: 100,
        name: 'Prepare laptop',
        sd: 'Image and configure a ${model} (${ram}) for ${requested_for}',
        group: 'Hardware Support',
        description: 'Enroll the device in management, encrypt the disk and install the standard bundle.',
      },
      {
        order: 200,
        name: 'Deliver laptop',
        sd: 'Deliver the laptop to ${requested_for}',
        group: 'Service Desk',
        stage: 'delivery',
        description: 'Hand the laptop over and walk the employee through the first sign-in.',
      },
    ],
  },
  {
    key: 'monitor',
    name: 'External Monitor',
    short: 'A second screen for your desk.',
    description: '<p>Monitors come with a height-adjustable stand and the cables for your dock.</p>',
    category: 'Hardware',
    icon: 'monitor',
    price: 249,
    group: 'Hardware Support',
    deliveryDays: 3,
    requesterSet: true,
    meta: 'screen, display, 4k',
    order: 200,
    vars: [
      {
        name: 'size',
        q: 'Size',
        type: VT.select,
        mandatory: true,
        def: '24',
        choices: [
          ['24', '24-inch Full HD', 0],
          ['27', '27-inch QHD', 110],
          ['32_4k', '32-inch 4K', 330],
        ],
      },
      {
        name: 'usage',
        q: 'What will you mainly use it for?',
        type: VT.multiLine,
        help: 'Required for the 32-inch model.',
      },
    ],
    steps: [
      {
        order: 100,
        name: 'Deliver monitor',
        sd: 'Deliver a ${size} monitor to ${requested_for}',
        group: 'Hardware Support',
      },
    ],
  },
  {
    key: 'headset',
    name: 'Headset',
    short: 'A headset for calls and meetings.',
    description:
      '<p>Certified for the company meeting tools. Noise cancelling is recommended for open spaces.</p>',
    category: 'Hardware',
    icon: 'headphones',
    price: 89,
    group: 'Service Desk',
    deliveryDays: 2,
    meta: 'audio, microphone, earphones',
    order: 300,
    vars: [
      {
        name: 'connection',
        q: 'Connection',
        type: VT.multipleChoice,
        def: 'usb',
        choices: [
          ['usb', 'Wired USB', 0],
          ['bluetooth', 'Wireless Bluetooth', 40],
        ],
      },
      { name: 'noise_cancelling', q: 'Active noise cancelling', type: VT.checkbox, ifChecked: 60 },
    ],
    steps: [
      {
        order: 100,
        name: 'Ship headset',
        sd: 'Send a headset (${connection}) to ${requested_for}',
        group: 'Service Desk',
      },
    ],
  },
  {
    key: 'dock',
    name: 'Docking Station',
    short: 'One cable for power, screens and network.',
    description: '<p>Universal USB-C docking station compatible with every standard laptop.</p>',
    category: 'Hardware',
    icon: 'plug',
    price: 239,
    group: 'Hardware Support',
    deliveryDays: 3,
    requesterSet: true,
    order: 400,
    vars: [
      {
        name: 'desk_location',
        q: 'Desk or office number',
        type: VT.singleLine,
        mandatory: true,
        regex: '^[A-Za-z0-9 .-]{1,20}$',
        example: 'AUS-3.214',
      },
      { name: 'second_power_adapter', q: 'Add a second power adapter', type: VT.checkbox, ifChecked: 45 },
    ],
    steps: [
      {
        order: 100,
        name: 'Install docking station',
        sd: 'Install a docking station at desk ${desk_location}',
        group: 'Hardware Support',
      },
    ],
  },
  {
    key: 'keyboard',
    name: 'Wireless Keyboard and Mouse',
    short: 'A keyboard and mouse set in your layout.',
    description: '<p>Rechargeable keyboard and mouse set.</p>',
    category: 'Hardware',
    icon: 'keyboard',
    price: 79,
    group: 'Service Desk',
    deliveryDays: 2,
    order: 500,
    vars: [
      {
        name: 'layout',
        q: 'Keyboard layout',
        type: VT.select,
        mandatory: true,
        def: 'us',
        choices: [
          ['us', 'US English'],
          ['uk', 'UK English'],
          ['de', 'German'],
          ['ar', 'Arabic'],
        ],
      },
    ],
  },
  {
    key: 'software',
    name: 'Software Installation',
    short: 'Install approved software on your computer.',
    description:
      '<p>Choose from the software titles approved by IT. Licensed titles are charged to your department.</p>',
    category: 'Software',
    icon: 'download',
    group: 'Service Desk',
    manager: true,
    deliveryDays: 2,
    requesterSet: true,
    meta: 'install, application, license, program',
    order: 100,
    vars: [
      {
        name: 'software',
        q: 'Software',
        type: VT.reference,
        ref: T.software,
        refQual: 'active=true',
        mandatory: true,
        pricing: true,
      },
      {
        name: 'device_name',
        q: 'Computer name',
        type: VT.singleLine,
        mandatory: true,
        regex: '^[A-Za-z0-9-]{3,30}$',
        example: 'NWL-LT-0421',
        help: 'The name is printed on the label under your laptop.',
      },
      { name: 'justification', q: 'Why do you need it?', type: VT.multiLine, mandatory: true },
    ],
    steps: [
      {
        order: 100,
        name: 'Install software',
        sd: 'Install ${software} on ${device_name}',
        group: 'Service Desk',
      },
    ],
  },
  {
    key: 'design_suite',
    name: 'Design Suite Subscription',
    short: 'Monthly license for the design and video tools.',
    description:
      '<p>Subscriptions renew monthly and are cancelled automatically when you leave the company.</p>',
    category: 'Software',
    icon: 'palette',
    recurring: 55,
    frequency: 'monthly',
    group: 'Service Desk',
    approvalGroups: ['Software Support'],
    deliveryDays: 1,
    requesterSet: true,
    meta: 'design, video, photo, license',
    order: 200,
    noQuantity: true,
    vars: [
      {
        name: 'plan',
        q: 'Plan',
        type: VT.select,
        mandatory: true,
        def: 'single',
        choices: [
          ['single', 'Single app', 0, 0],
          ['all_apps', 'All apps', 0, 35],
        ],
      },
    ],
    steps: [
      {
        order: 100,
        name: 'Assign license',
        sd: 'Assign a design suite license (${plan}) to ${requested_for}',
        group: 'Service Desk',
      },
    ],
  },
  {
    key: 'vpn',
    name: 'VPN Access',
    short: 'Connect to the company network from anywhere.',
    description:
      '<p>VPN profiles are tied to your role. Administrative profiles require multi-factor authentication on every connection.</p>',
    category: 'Access',
    icon: 'shield',
    group: 'Information Security',
    manager: true,
    deliveryDays: 1,
    requesterSet: true,
    meta: 'remote, network, home office',
    order: 100,
    vars: [
      {
        name: 'access_profile',
        q: 'Access profile',
        type: VT.select,
        mandatory: true,
        def: 'standard',
        choices: [
          ['standard', 'Standard (office applications)'],
          ['engineering', 'Engineering (development networks)'],
          ['admin', 'Administrative (infrastructure)'],
        ],
      },
      {
        name: 'end_date',
        q: 'Access needed until',
        type: VT.date,
        help: 'Leave empty for permanent access.',
      },
      { name: 'reason', q: 'Reason', type: VT.multiLine, mandatory: true },
    ],
    steps: [
      {
        order: 100,
        name: 'Create VPN profile',
        sd: 'Create a VPN profile (${access_profile}) for ${requested_for}',
        group: 'Information Security',
      },
      {
        order: 200,
        name: 'Send setup instructions',
        sd: 'Send VPN setup instructions to ${requested_for}',
        group: 'Service Desk',
        stage: 'delivery',
      },
    ],
  },
  {
    key: 'shared_drive',
    name: 'Shared Drive Access',
    short: 'Access to a shared network folder.',
    description: '<p>The folder owner is informed of every new access.</p>',
    category: 'Access',
    icon: 'folder-lock',
    group: 'Service Desk',
    manager: true,
    deliveryDays: 1,
    requesterSet: true,
    meta: 'folder, file share, network drive',
    order: 200,
    vars: [
      {
        name: 'share_path',
        q: 'Folder path',
        type: VT.singleLine,
        mandatory: true,
        regex: '^\\\\\\\\[A-Za-z0-9.-]+\\\\.+$',
        example: '\\\\fs01\\finance',
      },
      {
        name: 'access_level',
        q: 'Access level',
        type: VT.multipleChoice,
        def: 'read',
        choices: [
          ['read', 'Read only'],
          ['modify', 'Read and write'],
        ],
      },
      { name: 'reason', q: 'Reason', type: VT.multiLine, mandatory: true },
    ],
    steps: [
      {
        order: 100,
        name: 'Grant folder access',
        sd: 'Grant ${access_level} access to ${share_path} for ${requested_for}',
        group: 'Service Desk',
      },
    ],
  },
  {
    key: 'admin_rights',
    name: 'Temporary Administrator Rights',
    short: 'Local administrator rights on your computer for a limited time.',
    description:
      '<p>Available to engineering and IT staff. Every elevation is logged and reviewed by Information Security.</p>',
    category: 'Access',
    icon: 'key-round',
    group: 'Information Security',
    approvalGroups: ['Information Security'],
    deliveryDays: 1,
    availableFor: ['Engineering and IT staff'],
    order: 300,
    vars: [
      {
        name: 'device_name',
        q: 'Computer name',
        type: VT.singleLine,
        mandatory: true,
        regex: '^[A-Za-z0-9-]{3,30}$',
        example: 'NWL-LT-0421',
      },
      {
        name: 'duration',
        q: 'For how long?',
        type: VT.select,
        mandatory: true,
        def: '1d',
        choices: [
          ['1d', '1 day'],
          ['1w', '1 week'],
          ['30d', '30 days'],
        ],
      },
      { name: 'justification', q: 'Justification', type: VT.multiLine, mandatory: true },
    ],
    steps: [
      {
        order: 100,
        name: 'Grant administrator rights',
        sd: 'Grant local admin on ${device_name} for ${duration}',
        group: 'Information Security',
      },
    ],
  },
  {
    key: 'phone',
    name: 'New Mobile Phone',
    short: 'A company smartphone with a data plan.',
    description:
      '<p>Phones are enrolled in mobile device management before delivery. Plans are billed monthly to your department.</p>',
    category: 'Mobile',
    icon: 'smartphone',
    frequency: 'monthly',
    group: 'Hardware Support',
    manager: true,
    deliveryDays: 4,
    requesterSet: true,
    meta: 'smartphone, iphone, android, cell',
    order: 100,
    noQuantity: true,
    vars: [
      {
        name: 'model',
        q: 'Phone',
        type: VT.select,
        mandatory: true,
        choices: [
          ['galaxy_a', 'Samsung Galaxy A series', 399],
          ['iphone', 'Apple iPhone', 799],
        ],
      },
      {
        name: 'plan',
        q: 'Data plan',
        type: VT.select,
        mandatory: true,
        def: 'standard',
        choices: [
          ['standard', 'Standard 10 GB', 0, 25],
          ['unlimited', 'Unlimited', 0, 45],
        ],
      },
      { name: 'replacing', q: 'Is this replacing a phone you have now?', type: VT.yesNo, def: 'No' },
      {
        name: 'current_number',
        q: 'Current phone number',
        type: VT.singleLine,
        regex: '^\\+?[0-9 ()-]{7,20}$',
        example: '+1 512 555 0142',
        hidden: true,
      },
    ],
    steps: [
      {
        order: 100,
        name: 'Order and enroll phone',
        sd: 'Order and enroll a phone for ${requested_for}: ${model}, ${plan}',
        group: 'Hardware Support',
      },
      {
        order: 200,
        name: 'Hand over phone',
        sd: 'Hand the new phone to ${requested_for}',
        group: 'Service Desk',
        stage: 'delivery',
      },
    ],
  },
  {
    key: 'roaming',
    name: 'International Roaming',
    short: 'Turn on roaming for a business trip.',
    description: '<p>Roaming is switched on automatically for the dates of your trip.</p>',
    category: 'Mobile',
    icon: 'globe',
    price: 30,
    automation: 'fully_automated',
    deliveryDays: 1,
    requesterSet: true,
    meta: 'travel, abroad, data',
    order: 200,
    noQuantity: true,
    vars: [
      { name: 'destination', q: 'Destination country', type: VT.singleLine, mandatory: true },
      { name: 'travel_start', q: 'Departure date', type: VT.date, mandatory: true },
      { name: 'travel_end', q: 'Return date', type: VT.date, mandatory: true },
    ],
  },
];

/** Software titles referenced by the Software Installation item: name, publisher, version, category, price, monthly price. */
const SOFTWARE: [string, string, string, string, number, number][] = [
  ['Visual Studio Code', 'Microsoft', '1.94', 'development', 0, 0],
  ['JetBrains IntelliJ IDEA Ultimate', 'JetBrains', '2024.2', 'development', 0, 59],
  ['Tableau Desktop', 'Salesforce', '2024.3', 'analytics', 0, 75],
  ['Microsoft Visio', 'Microsoft', '2021', 'productivity', 280, 0],
  ['Slack', 'Salesforce', '4.40', 'communication', 0, 0],
  ['Zoom Workplace', 'Zoom', '6.2', 'communication', 0, 0],
  ['1Password', 'AgileBits', '8', 'security', 0, 8],
  ['Figma', 'Figma', 'desktop', 'design', 0, 15],
];

/** Runs `fn` with the clock moved `days` into the past (realistic demo timestamps). */
function at<R>(days: number, fn: () => R): R {
  const shift = Math.round(Math.max(0, days) * DAY);
  clock.advance(-shift);
  try {
    return fn();
  } finally {
    clock.advance(shift);
  }
}

export function seedCatalogDemo(ctx: Context): void {
  const platform = ctx.platform;
  const sys = ctx;
  const group = (name: string) => sys.first('sys_user_group', `name=${name}`)?.sysId ?? null;
  const user = (userName: string) => sys.first('sys_user', `user_name=${userName}`)?.sysId ?? null;
  if (!user('olivia.martin')) return; // the shared demo organization is not loaded

  // ------------------------------------------------------------- catalog
  const catalogId =
    platform.properties.get(PROP.defaultCatalog) ||
    sys.first(T.catalog, 'title=Service Catalog')?.sysId ||
    '';
  const catalog = catalogId ? sys.get(T.catalog, catalogId) : null;
  if (!catalog) return;
  sys.update(catalog, {
    title: 'IT Service Catalog',
    description:
      'Laptops, software, access and phones for Northwind Labs employees. Most requests are delivered within two working days.',
    manager: user('lucas.moreau'),
    editors: user('jamal.wright') ?? '',
  });
  grantRole(sys, user('lucas.moreau'), 'catalog_manager');
  grantRole(sys, user('jamal.wright'), 'catalog_editor');
  const categories = new Map<string, string>();
  const cats: [string, string, string, number][] = [
    ['Hardware', 'Laptops, screens and accessories', 'laptop', 100],
    ['Software', 'Applications and licenses', 'app-window', 200],
    ['Access', 'Network, folders and permissions', 'key-round', 300],
    ['Mobile', 'Phones and data plans', 'smartphone', 400],
    ['Onboarding', 'Everything a new colleague needs on day one', 'user-plus', 500],
  ];
  for (const [title, description, icon, order] of cats) {
    categories.set(
      title,
      sys.insert(T.category, { title, description, icon, order, sc_catalog: catalog.sysId, active: true })
        .sysId,
    );
  }

  // ------------------------------------------------------- shared records
  for (const [name, publisher, version, category, price, recurring] of SOFTWARE) {
    sys.insert(T.software, {
      name,
      publisher,
      version,
      category,
      price,
      recurring_price: recurring,
      license_type: recurring ? 'subscription' : price ? 'per_user' : 'free',
      active: true,
    });
  }
  const dept = (name: string) => sys.first('cmn_department', `name=${name}`)?.sysId ?? '';
  const criteria = new Map<string, string>();
  criteria.set(
    'Engineering and IT staff',
    sys.insert(T.criteria, {
      name: 'Engineering and IT staff',
      department: [dept('Engineering'), dept('IT')].filter(Boolean).join(','),
      active: true,
    }).sysId,
  );
  sys.insert(T.criteria, { name: 'Sales team', department: dept('Sales'), active: true });
  const requesterSet = sys.insert(T.variableSet, {
    title: 'Requester details',
    internal_name: 'requester_details',
    type: 'one_to_one',
    order: 100,
    description: 'Who the item is for and how to reach them',
  });
  addVariable(
    sys,
    { variable_set: requesterSet.sysId },
    { name: 'requested_for', q: 'Requested for', type: VT.requestedFor, mandatory: true, also: true },
    100,
  );
  addVariable(
    sys,
    { variable_set: requesterSet.sysId },
    {
      name: 'contact_phone',
      q: 'Phone number to reach you',
      type: VT.singleLine,
      regex: '^\\+?[0-9 ()-]{7,20}$',
      example: '+1 512 555 0142',
    },
    200,
  );

  // ---------------------------------------------------------------- items
  const items = new Map<string, Rec>();
  for (const spec of ITEMS) {
    const item = sys.insert(T.item, {
      name: spec.name,
      short_description: spec.short,
      description: spec.description,
      category: spec.category ? categories.get(spec.category) : null,
      sc_catalogs: catalog.sysId,
      icon: spec.icon,
      price: spec.price ?? 0,
      recurring_price: spec.recurring ?? 0,
      recurring_frequency: spec.frequency ?? null,
      group: spec.group ? group(spec.group) : null,
      u_manager_approval: !!spec.manager,
      delivery_time: (spec.deliveryDays ?? 2) * DAY,
      fulfillment_automation_level: spec.automation ?? (spec.steps?.length ? 'semi_automated' : 'manual'),
      meta: spec.meta ?? '',
      order: spec.order,
      no_quantity: !!spec.noQuantity,
      owner: user('lucas.moreau'),
      active: true,
    });
    items.set(spec.key, item);
    if (spec.requesterSet)
      sys.insert(T.setItem, { sc_cat_item: item.sysId, variable_set: requesterSet.sysId, order: 50 });
    spec.vars.forEach((v, i) => {
      addVariable(sys, { cat_item: item.sysId }, v, (i + 1) * 100);
    });
    for (const step of spec.steps ?? []) {
      sys.insert(T.step, {
        cat_item: item.sysId,
        order: step.order,
        name: step.name,
        short_description: step.sd,
        description: step.description ?? '',
        assignment_group: group(step.group),
        stage: step.stage === 'delivery' ? STAGE.delivery : STAGE.fulfillment,
        active: true,
      });
    }
    for (const g of spec.approvalGroups ?? [])
      if (group(g)) sys.insert(T.appGroup, { sc_cat_item: item.sysId, approver: group(g) });
    for (const c of spec.availableFor ?? [])
      if (criteria.get(c))
        sys.insert(T.itemAvailable, { sc_cat_item: item.sysId, user_criteria: criteria.get(c) });
  }

  // UI policies: the 4K monitor needs a reason; replacing a phone needs the current number.
  policy(sys, items.get('monitor')!, 'Explain why a 4K monitor is needed', 'size=32_4k', [
    { variable: 'usage', mandatory: 'true', visible: 'true' },
  ]);
  policy(sys, items.get('phone')!, 'Ask for the current number when replacing a phone', 'replacing=Yes', [
    { variable: 'current_number', mandatory: 'true', visible: 'true' },
  ]);

  // ----------------------------------------------------------- order guide
  const guide = sys.insert(T.guide, {
    name: 'New Hire Onboarding',
    short_description: 'Order everything a new colleague needs for their first day.',
    description:
      '<p>Answer a few questions about the new hire and we will propose the right equipment and access. You can adjust every item before submitting.</p>',
    category: categories.get('Onboarding'),
    sc_catalogs: catalog.sysId,
    icon: 'user-plus',
    cascade: true,
    two_step: true,
    include_items: true,
    owner: user('lucas.moreau'),
    order: 100,
    active: true,
  });
  addVariable(
    sys,
    { cat_item: guide.sysId },
    {
      name: 'requested_for',
      q: 'New hire',
      type: VT.requestedFor,
      mandatory: true,
      help: 'Create the user account in User Administration first.',
    },
    100,
  );
  addVariable(
    sys,
    { cat_item: guide.sysId },
    { name: 'start_date', q: 'Start date', type: VT.date, mandatory: true },
    200,
  );
  addVariable(
    sys,
    { cat_item: guide.sysId },
    {
      name: 'job_role',
      q: 'Role',
      type: VT.select,
      mandatory: true,
      choices: [
        ['engineering', 'Engineering'],
        ['sales', 'Sales'],
        ['office', 'Office and operations'],
      ],
    },
    300,
  );
  addVariable(
    sys,
    { cat_item: guide.sysId },
    { name: 'justification', q: 'Notes for IT', type: VT.multiLine, def: 'New hire equipment' },
    400,
  );
  const rules: [string, string, number][] = [
    ['laptop', '', 100],
    ['monitor', '', 200],
    ['headset', 'job_role=sales^ORjob_role=office', 300],
    ['phone', 'job_role=sales', 400],
    ['vpn', 'job_role=engineering', 500],
    ['software', 'job_role=engineering', 600],
  ];
  for (const [key, condition, position] of rules)
    sys.insert(T.guideRule, {
      guide: guide.sysId,
      item: items.get(key)!.sysId,
      condition,
      position,
      quantity: 1,
    });

  // ------------------------------------------------------- record producer
  let producer: Rec | null = null;
  if (platform.registry.has('incident')) {
    producer = sys.insert(T.producer, {
      name: 'Report an IT issue',
      short_description: 'Something is broken or not working as expected? Tell us and we will fix it.',
      description:
        '<p>Use this form for problems with your computer, software, network or accounts. For new equipment or access, browse the catalog instead.</p>',
      table_name: 'incident',
      sc_catalogs: catalog.sysId,
      icon: 'life-buoy',
      resolvr_template: 'contact_type=self-service',
      redirect_url: 'generated_record',
      owner: user('priya.nair'),
      order: 10,
      active: true,
    });
    addVariable(
      sys,
      { cat_item: producer.sysId },
      {
        name: 'short_description',
        q: 'What is the problem?',
        type: VT.singleLine,
        mandatory: true,
        attributes: 'max_length=160',
      },
      100,
    );
    addVariable(
      sys,
      { cat_item: producer.sysId },
      {
        name: 'description',
        q: 'Describe what happens',
        type: VT.multiLine,
        help: 'Include error messages and when it started.',
      },
      200,
    );
    if (platform.choices.list('incident', 'category').length) {
      addVariable(
        sys,
        { cat_item: producer.sysId },
        {
          name: 'category',
          q: 'What is it about?',
          type: VT.select,
          choiceTable: 'incident',
          choiceField: 'category',
        },
        300,
      );
    }
    addVariable(
      sys,
      { cat_item: producer.sysId },
      {
        name: 'urgency',
        q: 'How much does it affect your work?',
        type: VT.select,
        mandatory: true,
        def: '3',
        choices: [
          ['1', 'I cannot work'],
          ['2', 'I can work with difficulty'],
          ['3', 'It is an inconvenience'],
        ],
      },
      400,
    );
  }

  // --------------------------------------------------------------- requests
  try {
    seedDemoRequests(ctx, items, guide, producer, user);
  } catch (e) {
    platform.reportError('catalog demo requests', e);
  }
}

function grantRole(sys: Context, userId: string | null, role: string): void {
  if (!userId) return;
  const r = sys.getBy('sys_user_role', 'name', role);
  if (r && !sys.first('sys_user_has_role', `user=${userId}^role=${r.sysId}`))
    sys.insert('sys_user_has_role', { user: userId, role: r.sysId });
  sys.platform.users.invalidate();
}

function addVariable(sys: Context, owner: Record<string, string>, v: VarSpec, order: number): Rec {
  const rec = sys.insert(T.variable, {
    ...owner,
    name: v.name,
    question_text: v.q,
    type: v.type,
    order,
    mandatory: !!v.mandatory,
    hidden: !!v.hidden,
    default_value: v.def ?? '',
    reference: v.ref ?? '',
    reference_qual_condition: v.refQual ?? '',
    validate_regex: v.regex ?? '',
    example_text: v.example ?? '',
    help_text: v.help ?? '',
    show_help: !!v.help,
    price_if_checked: v.ifChecked ?? 0,
    pricing_implications: !!v.pricing,
    choice_table: v.choiceTable ?? '',
    choice_field: v.choiceField ?? '',
    enable_also_request_for: !!v.also,
    attributes: v.attributes ?? '',
    active: true,
  });
  (v.choices ?? []).forEach(([value, text, price, recurring], i) => {
    sys.insert(T.choice, {
      question: rec.sysId,
      value,
      text,
      order: (i + 1) * 100,
      price: price ?? 0,
      recurring_price: recurring ?? 0,
    });
  });
  return rec;
}

function policy(
  sys: Context,
  item: Rec,
  name: string,
  condition: string,
  actions: { variable: string; mandatory?: string; visible?: string }[],
): void {
  const p = sys.insert(T.uiPolicy, {
    applies_to: 'item',
    catalog_item: item.sysId,
    short_description: name,
    catalog_conditions: condition,
    reverse_if_false: true,
    on_load: true,
    applies_catalog: true,
    applies_req_item: true,
    active: true,
  });
  for (const a of actions)
    sys.insert(T.uiPolicyAction, {
      ui_policy: p.sysId,
      catalog_variable: a.variable,
      mandatory: a.mandatory ?? 'ignore',
      visible: a.visible ?? 'ignore',
    });
}

type Progress =
  | 'submitted'
  | 'approved'
  | 'working'
  | 'delivery'
  | 'completed'
  | 'incomplete'
  | 'rejected'
  | 'cancelled';

interface DemoOrder {
  who: string;
  item: string;
  days: number;
  progress: Progress;
  quantity?: number;
  vars: Record<string, string>;
}

const ORDERS: DemoOrder[] = [
  {
    who: 'olivia.martin',
    item: 'laptop',
    days: 28,
    progress: 'completed',
    vars: {
      model: 'latitude_14',
      ram: '32gb',
      extended_warranty: 'true',
      justification: 'My current laptop is four years old and the battery no longer lasts a meeting.',
    },
  },
  {
    who: 'noah.johnson',
    item: 'laptop',
    days: 2,
    progress: 'submitted',
    vars: {
      model: 'macbook_pro_14',
      ram: '16gb',
      justification: 'Replacement for a laptop with a cracked screen.',
    },
  },
  {
    who: 'james.davis',
    item: 'laptop',
    days: 6,
    progress: 'delivery',
    vars: {
      model: 'thinkpad_14',
      ram: '64gb',
      justification: 'Local builds of the data platform need more memory.',
    },
  },
  {
    who: 'emma.williams',
    item: 'monitor',
    days: 20,
    progress: 'completed',
    quantity: 2,
    vars: { size: '27' },
  },
  {
    who: 'liam.brown',
    item: 'monitor',
    days: 3,
    progress: 'working',
    vars: { size: '32_4k', usage: 'Video editing for the product launch campaign.' },
  },
  {
    who: 'ava.jones',
    item: 'headset',
    days: 15,
    progress: 'completed',
    vars: { connection: 'bluetooth', noise_cancelling: 'true' },
  },
  { who: 'ethan.garcia', item: 'headset', days: 0.2, progress: 'approved', vars: { connection: 'usb' } },
  { who: 'mia.miller', item: 'dock', days: 10, progress: 'incomplete', vars: { desk_location: 'LON-2.118' } },
  { who: 'layla.hassan', item: 'keyboard', days: 8, progress: 'completed', vars: { layout: 'ar' } },
  {
    who: 'james.davis',
    item: 'software',
    days: 4,
    progress: 'working',
    vars: {
      software: 'JetBrains IntelliJ IDEA Ultimate',
      device_name: 'NWL-LT-0421',
      justification: 'Kotlin services in the billing team.',
    },
  },
  {
    who: 'olivia.martin',
    item: 'software',
    days: 12,
    progress: 'rejected',
    vars: {
      software: 'Tableau Desktop',
      device_name: 'NWL-LT-0198',
      justification: 'Build my own pipeline dashboards.',
    },
  },
  { who: 'layla.hassan', item: 'design_suite', days: 1, progress: 'submitted', vars: { plan: 'all_apps' } },
  { who: 'noor.haddad', item: 'design_suite', days: 18, progress: 'completed', vars: { plan: 'single' } },
  {
    who: 'ethan.garcia',
    item: 'vpn',
    days: 5,
    progress: 'working',
    vars: { access_profile: 'standard', reason: 'Customer visits across the region.' },
  },
  {
    who: 'alex.rivera',
    item: 'vpn',
    days: 25,
    progress: 'completed',
    vars: { access_profile: 'admin', reason: 'On-call support for the service desk tools.' },
  },
  {
    who: 'noah.johnson',
    item: 'vpn',
    days: 6,
    progress: 'cancelled',
    vars: { access_profile: 'standard', reason: 'Working from home on Fridays.' },
  },
  {
    who: 'noah.johnson',
    item: 'shared_drive',
    days: 1,
    progress: 'submitted',
    vars: {
      share_path: '\\\\fs01\\finance\\forecasts',
      access_level: 'modify',
      reason: 'Quarterly forecast preparation.',
    },
  },
  {
    who: 'emma.williams',
    item: 'shared_drive',
    days: 9,
    progress: 'completed',
    vars: { share_path: '\\\\fs02\\hr\\policies', access_level: 'read', reason: 'Policy reviews.' },
  },
  {
    who: 'james.davis',
    item: 'admin_rights',
    days: 2,
    progress: 'working',
    vars: {
      device_name: 'NWL-LT-0421',
      duration: '1w',
      justification: 'Install a database driver for the integration tests.',
    },
  },
  {
    who: 'olivia.martin',
    item: 'phone',
    days: 7,
    progress: 'delivery',
    vars: { model: 'iphone', plan: 'unlimited', replacing: 'Yes', current_number: '+1 512 555 0177' },
  },
  {
    who: 'ava.jones',
    item: 'roaming',
    days: 11,
    progress: 'completed',
    vars: { destination: 'Japan', travel_start: '2026-10-14', travel_end: '2026-10-24' },
  },
];

function seedDemoRequests(
  ctx: Context,
  items: Map<string, Rec>,
  guide: Rec,
  producer: Rec | null,
  user: (userName: string) => string | null,
): void {
  const platform = ctx.platform;
  const sys = ctx;
  const f = fulfillmentOf(platform);
  const approvals = optionalService<ApprovalService>(platform, SERVICES.approvals);
  const member = (groupId: string): string | null =>
    groupId ? sys.first('sys_user_grmember', `group=${groupId}`)?.str('user') || null : null;
  const reload = (r: Rec) => sys.get(T.ritm, r.sysId) ?? r;

  /** Approves or rejects the pending approvals of a record as the approvers themselves. */
  const decideAll = (rec: Rec, decision: 'approved' | 'rejected', comment?: string) => {
    if (!approvals || !platform.registry.has(T.approval)) return;
    for (const row of sys.query(T.approval, { query: `document_id=${rec.sysId}^state=requested` })) {
      const fresh = sys.get(T.approval, row.sysId);
      if (fresh?.str('state') !== 'requested') continue;
      approvals.decide(platform.contextAs(row.str('approver')), fresh, decision, comment);
      if (decision === 'rejected') break;
    }
    platform.drain();
  };

  /** Works the open catalog tasks of an item: picks them up, then optionally closes them. */
  const work = (ritm: Rec, outcome: 'start' | 'complete' | 'incomplete', note?: string) => {
    for (const t of sys.query(T.task, { query: `request_item=${ritm.sysId}^active=true` })) {
      const assignee = member(t.str('assignment_group'));
      const as = assignee ? platform.contextAs(assignee).elevated() : sys;
      as.update(t, { assigned_to: assignee, state: STATE.wip, work_notes: 'Picked up' });
      if (outcome === 'start') continue;
      const fresh = as.get(T.task, t.sysId);
      if (!fresh) continue;
      as.update(
        fresh,
        outcome === 'complete'
          ? { state: STATE.complete, close_notes: note ?? 'Done and confirmed with the requester' }
          : { state: STATE.incomplete, close_notes: note ?? 'Could not be completed' },
      );
    }
    platform.drain();
  };

  for (const o of ORDERS) {
    const item = items.get(o.item);
    const who = user(o.who);
    if (!item || !who) continue;
    try {
      const userCtx = platform.contextAs(who);
      const result = at(o.days, () => {
        const r = orderNow(userCtx, sys.get(T.item, item.sysId)!, {
          quantity: o.quantity ?? 1,
          variables: o.vars,
        });
        platform.drain();
        return r;
      });
      let ritm = reload(result.items[0]);
      if (o.progress === 'cancelled') {
        at(o.days - 0.5, () =>
          f.cancelRequest(userCtx, sys.get(T.request, result.request.sysId)!, 'No longer needed'),
        );
        continue;
      }
      if (o.progress === 'rejected') {
        at(o.days - 1, () => decideAll(ritm, 'rejected', 'Please use the shared team dashboards instead.'));
        continue;
      }
      if (ritm.str('stage') === STAGE.waiting && o.progress !== 'submitted')
        at(o.days - 0.8, () => decideAll(ritm, 'approved', 'Approved'));
      ritm = reload(ritm);
      if (o.progress === 'submitted' || o.progress === 'approved') continue;
      if (o.progress === 'working') {
        at(o.days - 1, () => work(ritm, 'start'));
        continue;
      }
      if (o.progress === 'incomplete') {
        at(o.days - 2, () =>
          work(
            ritm,
            'incomplete',
            'Desk LON-2.118 does not exist on the London floor plan; the requester was asked to order again.',
          ),
        );
        continue;
      }
      at(o.days - 1.5, () => work(ritm, 'complete'));
      ritm = reload(ritm);
      if (o.progress === 'delivery') continue;
      if (ritm.bool('active')) at(o.days - 2.5, () => work(ritm, 'complete', 'Delivered in person'));
    } catch (e) {
      platform.reportError(`catalog demo order ${o.item} for ${o.who}`, e);
    }
  }

  // A manager onboards a new sales colleague with the order guide.
  const newHire =
    user('sam.patel') ??
    sys.insert('sys_user', {
      user_name: 'sam.patel',
      first_name: 'Sam',
      last_name: 'Patel',
      title: 'Account Executive',
      email: 'sam.patel@northwind.example',
      department: sys.first('cmn_department', 'name=Sales')?.sysId ?? null,
      location: sys.first('cmn_location', 'name=Austin HQ')?.sysId ?? null,
      manager: user('charlotte.taylor'),
      user_password: DEMO_PASSWORD,
      active: true,
    }).sysId;
  platform.users.invalidate();
  const manager = user('charlotte.taylor');
  if (manager) {
    try {
      const managerCtx = platform.contextAs(manager);
      const answers: Record<string, Record<string, string>> = {
        [items.get('laptop')!.sysId]: { model: 'latitude_14', ram: '16gb' },
        [items.get('monitor')!.sysId]: { size: '27' },
        [items.get('phone')!.sysId]: { model: 'galaxy_a', plan: 'unlimited' },
      };
      const order = at(3, () => {
        const evaluation = evaluateGuide(managerCtx, sys.get(T.guide, guide.sysId)!, {
          requested_for: newHire,
          start_date: '2026-11-02',
          job_role: 'sales',
          justification: 'Sam joins the enterprise sales team in Austin.',
        });
        const lines = evaluation.items.map((s) => ({
          sys_id: s.item.sysId,
          quantity: s.quantity,
          variables: answers[s.item.sysId] ?? {},
        }));
        const r = orderGuide(managerCtx, evaluation, lines, {
          specialInstructions: 'Please have everything at the Austin IT bar on the first morning.',
        });
        platform.drain();
        return r;
      });
      for (const ritm of order.items) {
        const fresh = reload(ritm);
        if (fresh.str('stage') === STAGE.waiting)
          at(2.5, () => decideAll(fresh, 'approved', 'Welcome aboard, Sam'));
      }
      const monitor = order.items.map(reload).find((r) => r.str('cat_item') === items.get('monitor')!.sysId);
      if (monitor) at(1, () => work(monitor, 'complete', 'Monitor ready at the IT bar'));
    } catch (e) {
      platform.reportError('catalog demo onboarding', e);
    }
  }

  // Incidents reported through the record producer.
  if (producer) {
    const reports: [string, number, Record<string, string>][] = [
      [
        'liam.brown',
        1,
        {
          short_description: 'Laptop battery drains in about an hour',
          description: 'Since last week the battery goes from full to empty during a single meeting.',
          urgency: '2',
        },
      ],
      [
        'mia.miller',
        0.3,
        {
          short_description: 'Cannot open the shared contracts folder',
          description: 'Access denied on \\\\fs02\\legal since this morning.',
          urgency: '1',
        },
      ],
    ];
    for (const [who, days, vars] of reports) {
      const id = user(who);
      if (!id) continue;
      try {
        at(days, () =>
          submitProducer(platform.contextAs(id), sys.get(T.producer, producer.sysId)!, { variables: vars }),
        );
      } catch (e) {
        platform.reportError('catalog demo producer', e);
      }
    }
  }
}
