/**
 * Sample data for development and demos.
 * DEVELOPMENT PASSWORDS ONLY - never use these accounts in production.
 */

export const SEED_USERS = [
  { employeeId: 'PKT0001', firstName: 'Super', lastName: 'Admin', email: 'admin@pkt.local', password: 'Admin@123', role: 'SUPER_ADMIN', department: 'Administration', designation: 'Platform Administrator', team: 'Platform', location: 'Mumbai' },
  { employeeId: 'PKT0002', firstName: 'Priya', lastName: 'Menon', email: 'manager@pkt.local', password: 'Manager@123', role: 'MANAGER', department: 'Customer Support', designation: 'Team Manager', team: 'Support Leads', location: 'Mumbai' },
  { employeeId: 'PKT0003', firstName: 'Rahul', lastName: 'Sharma', email: 'user@pkt.local', password: 'User@123', role: 'USER', department: 'Customer Support', designation: 'Support Executive', team: 'Support Team A', location: 'Mumbai', productGroup: 'Contact Center', manager: 'manager@pkt.local' },
  { employeeId: 'PKT0004', firstName: 'Anita', lastName: 'Desai', email: 'productadmin@pkt.local', password: 'ProductAdmin@123', role: 'PRODUCT_ADMIN', department: 'Product', designation: 'Product Manager', team: 'VAANI Product', location: 'Bengaluru', products: ['VAANI'] },
  { employeeId: 'PKT0005', firstName: 'Vikram', lastName: 'Iyer', email: 'trainer@pkt.local', password: 'Trainer@123', role: 'TRAINER', department: 'Training', designation: 'Senior Trainer', team: 'L&D', location: 'Pune' },
  { employeeId: 'PKT0006', firstName: 'Meera', lastName: 'Kapoor', email: 'auditor@pkt.local', password: 'Auditor@123', role: 'AUDITOR', department: 'Compliance', designation: 'Quality Auditor', team: 'Audit', location: 'Delhi' },
  // Demo team members (used to generate sample results for dashboards).
  { employeeId: 'PKT0101', firstName: 'Karan', lastName: 'Patel', email: 'karan.patel@pkt.local', password: 'User@123', role: 'USER', department: 'Customer Support', designation: 'Support Executive', team: 'Support Team A', location: 'Mumbai', productGroup: 'Contact Center', manager: 'manager@pkt.local' },
  { employeeId: 'PKT0102', firstName: 'Sneha', lastName: 'Reddy', email: 'sneha.reddy@pkt.local', password: 'User@123', role: 'USER', department: 'Customer Support', designation: 'Support Executive', team: 'Support Team A', location: 'Hyderabad', productGroup: 'Contact Center', manager: 'manager@pkt.local' },
  { employeeId: 'PKT0103', firstName: 'Arjun', lastName: 'Nair', email: 'arjun.nair@pkt.local', password: 'User@123', role: 'USER', department: 'Sales', designation: 'Sales Associate', team: 'Support Team A', location: 'Chennai', productGroup: 'Contact Center', manager: 'manager@pkt.local' },
  { employeeId: 'PKT0104', firstName: 'Fatima', lastName: 'Khan', email: 'fatima.khan@pkt.local', password: 'User@123', role: 'USER', department: 'Sales', designation: 'Sales Associate', team: 'Support Team A', location: 'Delhi', productGroup: 'Contact Center', manager: 'manager@pkt.local' },
  { employeeId: 'PKT0105', firstName: 'Rohan', lastName: 'Gupta', email: 'rohan.gupta@pkt.local', password: 'User@123', role: 'USER', department: 'Operations', designation: 'Operations Analyst', team: 'Support Team A', location: 'Pune', productGroup: 'Contact Center', manager: 'manager@pkt.local' },
] as const;

export const SEED_PRODUCTS = [
  { productCode: 'VAANI', productName: 'VAANI', category: 'Contact Center', productOwner: 'Anita Desai', description: 'Omnichannel contact center dialer and inbound platform.' },
  { productCode: 'VOICEAI', productName: 'Voice AI', category: 'Artificial Intelligence', productOwner: 'Product Team', description: 'Conversational voice bots and speech analytics.' },
  { productCode: 'AUDITAI', productName: 'Audit AI', category: 'Quality', productOwner: 'Quality Team', description: 'Automated call and chat quality auditing.' },
  { productCode: 'WFM', productName: 'Workforce Management', category: 'Operations', productOwner: 'Operations Team', description: 'Forecasting, scheduling and adherence.' },
  { productCode: 'OMNI', productName: 'Omnichannel', category: 'Contact Center', productOwner: 'Product Team', description: 'Unified email, chat, social and messaging channels.' },
] as const;

export const VAANI_TOPICS: Array<{ name: string; subtopics: string[] }> = [
  { name: 'Product Basics', subtopics: [] },
  { name: 'Dialing', subtopics: ['Predictive', 'Progressive', 'Preview'] },
  { name: 'Inbound', subtopics: ['IVR', 'Queue', 'DID Routing'] },
  { name: 'Campaign', subtopics: [] },
  { name: 'Reports', subtopics: [] },
];

type D = 'EASY' | 'MEDIUM' | 'HARD';
export interface SeedQuestion {
  topic: string;
  subtopic?: string;
  difficulty: D;
  text: string;
  options: string[];
  correct: number; // index into options
  explanation: string;
}

export const VAANI_QUESTIONS: SeedQuestion[] = [
  // ---- Product Basics ----
  { topic: 'Product Basics', difficulty: 'EASY', text: 'What is VAANI primarily used for?', options: ['Payroll processing', 'Running contact center outbound and inbound operations', 'Graphic design', 'Inventory accounting'], correct: 1, explanation: 'VAANI is a contact center platform that handles outbound dialing and inbound call routing.' },
  { topic: 'Product Basics', difficulty: 'EASY', text: 'Which user role in VAANI typically handles live customer calls?', options: ['Agent', 'Auditor', 'Database administrator', 'Billing clerk'], correct: 0, explanation: 'Agents handle live customer interactions; supervisors and admins manage configuration and monitoring.' },
  { topic: 'Product Basics', difficulty: 'MEDIUM', text: 'What does an agent "disposition" record in VAANI?', options: ['The agent\'s login password', 'The outcome of a call, such as Sale, Callback or Not Interested', 'The server hardware configuration', 'The customer\'s credit card number'], correct: 1, explanation: 'A disposition captures the outcome of each interaction and drives callbacks, reporting and list recycling.' },
  { topic: 'Product Basics', difficulty: 'MEDIUM', text: 'What is "wrap-up time" (ACW) in VAANI?', options: ['Time an agent spends on lunch', 'Time after a call ends when the agent completes notes and disposition', 'Time the IVR plays music', 'Time taken to load a lead list'], correct: 1, explanation: 'After Call Work (wrap-up) is the period after the call where the agent finishes notes and sets the disposition.' },
  { topic: 'Product Basics', difficulty: 'HARD', text: 'Why should wrap-up time be capped for outbound campaigns using automatic dialing?', options: ['It reduces telecom charges for inbound calls', 'Long wrap-up keeps agents unavailable, lowering dialer pacing accuracy and productivity', 'It prevents agents from logging out', 'It is required to record calls'], correct: 1, explanation: 'Dialers pace calls based on agent availability; uncontrolled wrap-up time distorts pacing and reduces talk time.' },

  // ---- Dialing ----
  { topic: 'Dialing', subtopic: 'Predictive', difficulty: 'EASY', text: 'Which dialing mode predicts agent availability?', options: ['Manual', 'Preview', 'Predictive', 'Progressive'], correct: 2, explanation: 'Predictive dialing automatically predicts agent availability and initiates calls accordingly.' },
  { topic: 'Dialing', subtopic: 'Predictive', difficulty: 'MEDIUM', text: 'What is the main risk of setting a very high dialing ratio in predictive mode?', options: ['Agents get too much idle time', 'Increased abandoned (dropped) calls when no agent is free', 'Calls cannot be recorded', 'Lead lists get deleted'], correct: 1, explanation: 'Over-dialing connects more customers than available agents, causing abandoned calls and possible compliance issues.' },
  { topic: 'Dialing', subtopic: 'Progressive', difficulty: 'MEDIUM', text: 'How does progressive dialing differ from predictive dialing?', options: ['It dials one number per available agent, only when an agent becomes free', 'It lets the agent review the record before dialing', 'It dials several numbers per agent at once', 'It only works for inbound calls'], correct: 0, explanation: 'Progressive dialing places one call per available agent, avoiding abandoned calls at the cost of some idle time.' },
  { topic: 'Dialing', subtopic: 'Preview', difficulty: 'EASY', text: 'In which dialing mode does the agent see customer details before the call is placed?', options: ['Predictive', 'Progressive', 'Preview', 'Blaster'], correct: 2, explanation: 'Preview dialing shows the record to the agent first, useful for complex or high-value calls.' },
  { topic: 'Dialing', subtopic: 'Preview', difficulty: 'HARD', text: 'For a low-volume, high-value B2B campaign where agents must research each account, which dialing mode is most appropriate?', options: ['Predictive with ratio 3:1', 'Preview', 'Progressive with no wrap-up', 'Voice broadcast'], correct: 1, explanation: 'Preview mode gives agents time to study the account before dialing, which suits complex, high-value conversations.' },

  // ---- Inbound ----
  { topic: 'Inbound', subtopic: 'IVR', difficulty: 'EASY', text: 'What does IVR stand for?', options: ['Internal Voice Relay', 'Interactive Voice Response', 'Integrated Video Recording', 'Inbound Verification Routine'], correct: 1, explanation: 'Interactive Voice Response lets callers interact with menus using keypad or speech before reaching an agent.' },
  { topic: 'Inbound', subtopic: 'Queue', difficulty: 'MEDIUM', text: 'What happens to an inbound call when all agents in the target skill are busy?', options: ['It is disconnected immediately', 'It waits in the queue until an agent is available or an overflow rule applies', 'It is sent to a random department', 'It is converted to an email'], correct: 1, explanation: 'Calls wait in the skill queue, with configurable overflow, callback or voicemail rules.' },
  { topic: 'Inbound', subtopic: 'DID Routing', difficulty: 'MEDIUM', text: 'What is DID-based routing used for?', options: ['Routing calls based on the number the customer dialled', 'Deleting inactive dispositions', 'Detecting duplicate leads', 'Dialing international destinations'], correct: 0, explanation: 'Direct Inward Dialing routing sends calls to a flow, IVR or queue based on the dialled number.' },
  { topic: 'Inbound', subtopic: 'Queue', difficulty: 'HARD', text: 'Which setting best reduces abandonment for callers who have waited too long in queue?', options: ['Disable music on hold', 'Offer a callback or overflow to another skill after a wait-time threshold', 'Increase the IVR menu depth', 'Lower the recording quality'], correct: 1, explanation: 'Time-based overflow or virtual callback keeps callers from abandoning while protecting service levels.' },
  { topic: 'Inbound', subtopic: 'IVR', difficulty: 'HARD', text: 'Why should IVR menus usually be limited to a few options per level?', options: ['Telecom providers charge per option', 'Long menus increase caller effort, misroutes and abandonment', 'VAANI cannot store more than three prompts', 'It is needed for call recording'], correct: 1, explanation: 'Short, clear menus improve routing accuracy and caller experience.' },

  // ---- Campaign ----
  { topic: 'Campaign', difficulty: 'EASY', text: 'What is a campaign in VAANI?', options: ['A payroll run', 'A configured calling process with its own leads, dialing mode, agents and dispositions', 'A report export', 'A type of IVR prompt'], correct: 1, explanation: 'A campaign groups lead lists, dialing settings, agents and dispositions for a business process.' },
  { topic: 'Campaign', difficulty: 'MEDIUM', text: 'What is list recycling in a campaign?', options: ['Deleting all leads daily', 'Re-dialing leads with selected dispositions (e.g., No Answer) after a set interval', 'Moving agents between campaigns', 'Archiving call recordings'], correct: 1, explanation: 'Recycling re-queues leads with chosen outcomes so they are attempted again after a delay.' },
  { topic: 'Campaign', difficulty: 'MEDIUM', text: 'Why are DNC (Do Not Call) lists applied to outbound campaigns?', options: ['To improve audio quality', 'To prevent calling customers who have opted out, for regulatory compliance', 'To speed up dialing', 'To assign leads to agents'], correct: 1, explanation: 'DNC scrubbing ensures opted-out numbers are never dialled, protecting compliance.' },
  { topic: 'Campaign', difficulty: 'HARD', text: 'A campaign shows high agent idle time but a very low abandon rate in predictive mode. What is the most likely adjustment?', options: ['Lower the dialing ratio', 'Carefully increase the dialing ratio or pacing aggressiveness', 'Switch the campaign to inbound only', 'Increase wrap-up time'], correct: 1, explanation: 'Low abandonment with high idle time indicates under-dialing; pacing can be raised while monitoring abandon rate.' },
  { topic: 'Campaign', difficulty: 'EASY', text: 'Which field is essential in a lead list for an outbound campaign?', options: ['Customer phone number', 'Agent password', 'Server IP address', 'IVR prompt file'], correct: 0, explanation: 'Every outbound lead needs a valid phone number to be dialled.' },

  // ---- Reports ----
  { topic: 'Reports', difficulty: 'EASY', text: 'Which report shows how long agents spent talking, waiting and in wrap-up?', options: ['Agent performance / productivity report', 'DNC report', 'Lead upload report', 'IVR prompt list'], correct: 0, explanation: 'Agent productivity reports break down login, talk, idle, hold and wrap-up time.' },
  { topic: 'Reports', difficulty: 'MEDIUM', text: 'What does Average Handle Time (AHT) include?', options: ['Only ringing time', 'Talk time + hold time + wrap-up time', 'Only queue wait time', 'Login time divided by calls'], correct: 1, explanation: 'AHT = talk + hold + after-call work, averaged over handled calls.' },
  { topic: 'Reports', difficulty: 'MEDIUM', text: 'What does the Service Level metric (e.g., 80/20) measure for inbound queues?', options: ['80% of agents logged in for 20 minutes', 'Percentage of calls answered within a target time, e.g., 80% within 20 seconds', '80 calls handled per 20 agents', 'Abandon rate of 20%'], correct: 1, explanation: 'Service level is the share of calls answered within the target threshold.' },
  { topic: 'Reports', difficulty: 'HARD', text: 'Abandon rate is rising while AHT is stable and staffing is unchanged. What should be checked first in reports?', options: ['Changes in call arrival volume and interval-wise queue wait times', 'The number of IVR prompt files', 'Agent password expiry dates', 'Lead upload file sizes'], correct: 0, explanation: 'With stable AHT and staffing, higher abandonment usually comes from higher or shifted call volume; interval reports reveal it.' },
  { topic: 'Reports', difficulty: 'EASY', text: 'Which report helps verify the outcome distribution of calls in a campaign?', options: ['Disposition summary report', 'Server health report', 'User creation report', 'Password policy report'], correct: 0, explanation: 'The disposition summary shows how many calls ended in each outcome.' },
];
