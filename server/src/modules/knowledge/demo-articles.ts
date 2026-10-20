/**
 * Demo knowledge articles for the fictional company Northwind Labs. All content is
 * original sample writing for ResolvrNow.
 */
export interface DemoArticle {
  key: string;
  kb: 'help' | 'runbooks';
  /** Category path, e.g. `Network & Remote Access > VPN`. */
  category: string;
  author: string;
  title: string;
  meta: string;
  views: number;
  /** Target average star rating used to generate demo feedback. */
  quality: number;
  /** Published this many days ago. */
  age: number;
  featured?: boolean;
  /** Template class and its fields (the body is generated from them). */
  table?: string;
  fields?: Record<string, string>;
  html?: string;
  comments?: string[];
}

export const DEMO_CATEGORIES: Record<'help' | 'runbooks', string[]> = {
  help: [
    'Network & Remote Access > VPN',
    'Network & Remote Access > Wi-Fi',
    'Accounts & Security > Passwords',
    'Accounts & Security > Multi-factor authentication',
    'Accounts & Security > Phishing and safe computing',
    'Email & Collaboration > Email and calendar',
    'Email & Collaboration > Meetings',
    'Email & Collaboration > Files and sharing',
    'Devices > Laptops',
    'Devices > Printers',
    'Devices > Mobile devices',
    'Software & Access',
    'Getting Started',
  ],
  runbooks: [
    'Service Desk Procedures',
    'Identity & Access',
    'Network Operations',
    'Endpoint Management',
    'Major Incidents',
    'Known Errors',
  ],
};

export const DEMO_ARTICLES: DemoArticle[] = [
  {
    key: 'vpn',
    kb: 'help',
    category: 'Network & Remote Access > VPN',
    author: 'hannah.lee',
    title: 'Connect to the corporate VPN',
    meta: 'vpn, remote access, work from home, northwind vpn',
    views: 412,
    quality: 4.6,
    age: 210,
    featured: true,
    comments: [
      'Worked first time from the hotel once I accepted the Wi-Fi terms page. Thanks!',
      'Good to know Teams does not need the VPN, my calls are much smoother now.',
    ],
    html: `<p>The Northwind VPN gives you a secure connection to internal systems (file shares, the finance applications and the intranet) when you work outside the office. You do not need the VPN in the office, or for Microsoft 365 apps such as Outlook and Teams.</p>
<h3>Before you start</h3>
<ul>
<li>Your laptop must be a Northwind-managed device. Personal computers cannot connect.</li>
<li>Multi-factor authentication (MFA) must be set up on your phone. See <em>Enrol in multi-factor authentication</em> if you have not done this yet.</li>
<li>You need a working internet connection. Hotel and airport Wi-Fi often asks you to accept terms in a browser first.</li>
</ul>
<h3>Connect</h3>
<ol>
<li>Open the <strong>Northwind VPN</strong> app. On Windows it sits in the system tray (bottom right, you may need to select the arrow); on macOS it is in the menu bar.</li>
<li>Check that the portal address is <code>vpn.northwind.example</code>. Only change it if the Service Desk asks you to.</li>
<li>Select <strong>Connect</strong> and sign in with your Northwind email address and password.</li>
<li>Approve the sign-in request on your phone.</li>
<li>Wait until the icon shows <strong>Connected</strong>. This normally takes 5 to 15 seconds.</li>
</ol>
<h3>Good to know</h3>
<ul>
<li>The VPN disconnects after 12 hours, or after 30 minutes without traffic. Reconnect the same way.</li>
<li>Video calls work better with the VPN off: Teams traffic does not need it.</li>
<li>If the app is missing, install <strong>Northwind VPN</strong> from the Software Center.</li>
</ul>
<p>Still stuck? See <em>VPN connects but internal sites do not load</em>, or contact the Service Desk.</p>`,
  },
  {
    key: 'vpn-troubleshoot',
    kb: 'help',
    category: 'Network & Remote Access > VPN',
    author: 'marcus.chen',
    title: 'VPN connects but internal sites or drives do not load',
    meta: 'vpn, dns, mapped drive, intranet, troubleshooting',
    views: 188,
    quality: 4.2,
    age: 160,
    comments: ['Flushing DNS fixed it for me.'],
    html: `<p>If the VPN app says <strong>Connected</strong> but intranet pages time out or mapped drives show a red cross, work through these checks in order. Most cases are fixed by step 2 or 3.</p>
<ol>
<li><strong>Check the address you are using.</strong> Internal sites end in <code>.corp.northwind.example</code>. Bookmarks that use an IP address may be out of date.</li>
<li><strong>Disconnect and reconnect.</strong> Wait 10 seconds between the two so the old session closes completely.</li>
<li><strong>Flush the DNS cache.</strong>
<ul>
<li>Windows: open Command Prompt and run <code>ipconfig /flushdns</code>.</li>
<li>macOS: open Terminal and run <code>sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder</code>.</li>
</ul></li>
<li><strong>Check your home network range.</strong> If your home router hands out 10.20.x.x addresses, it overlaps with the office network. Ask the Service Desk for the overlap workaround.</li>
<li><strong>Re-open mapped drives after connecting.</strong> Drives mapped before the VPN connected stay offline. Double-click the drive in File Explorer, or sign out and back in with the VPN connected.</li>
<li><strong>Try another network.</strong> A phone hotspot quickly tells you whether the problem is your local network.</li>
</ol>
<h3>When you contact the Service Desk</h3>
<p>Include the time it happened, the site or drive you tried, and the result of step 6. A screenshot of the <em>Details</em> tab in the VPN app helps the network team.</p>`,
  },
  {
    key: 'wifi',
    kb: 'help',
    category: 'Network & Remote Access > Wi-Fi',
    author: 'marcus.chen',
    title: 'Connect to the office Wi-Fi',
    meta: 'wifi, wireless, NWL-Corp, NWL-Guest, guest network',
    views: 265,
    quality: 4.5,
    age: 300,
    html: `<p>Northwind offices have two wireless networks. Use the right one so you can reach company systems.</p>
<table>
<tr><th>Network</th><th>Who it is for</th><th>How you sign in</th></tr>
<tr><td>NWL-Corp</td><td>Northwind laptops and enrolled company phones</td><td>Automatically, with the device certificate</td></tr>
<tr><td>NWL-Guest</td><td>Visitors and personal devices</td><td>Daily password from reception; internet only</td></tr>
</table>
<h3>Company laptop</h3>
<ol>
<li>Select the Wi-Fi icon and choose <strong>NWL-Corp</strong>.</li>
<li>The laptop connects without asking for a password. If you are asked for one, cancel: the device certificate is missing (see below).</li>
</ol>
<h3>Phone or tablet</h3>
<ol>
<li>Enrolled company phones join <strong>NWL-Corp</strong> automatically.</li>
<li>Personal phones use <strong>NWL-Guest</strong>. Ask reception for today's password; it changes at midnight local time.</li>
</ol>
<h3>If NWL-Corp asks for a password</h3>
<p>Your device certificate has expired or was never installed. Connect to NWL-Guest, open the Software Center, run <strong>Refresh Wi-Fi certificate</strong> and restart. If the action is not listed, contact the Service Desk.</p>
<p>Guest access is internet only. Internal systems are only available from company devices.</p>`,
  },
  {
    key: 'wifi-drops',
    kb: 'help',
    category: 'Network & Remote Access > Wi-Fi',
    author: 'jamal.wright',
    title: 'Wi-Fi keeps dropping on your laptop',
    meta: 'wifi, disconnects, drops, wireless driver, power saving',
    views: 143,
    quality: 3.9,
    age: 95,
    html: `<p>Short drops (a few seconds every few minutes) are usually caused by roaming between access points, power saving or an old driver. Each step below takes less than five minutes.</p>
<h3>1. Forget and re-join the network</h3>
<p>Open Wi-Fi settings, select <strong>NWL-Corp</strong>, choose <em>Forget</em> and connect again. This clears a stale profile, for example after an office move.</p>
<h3>2. Turn off adapter power saving (Windows)</h3>
<ol>
<li>Right-click Start and open <strong>Device Manager</strong>.</li>
<li>Expand <strong>Network adapters</strong>, right-click the wireless adapter and choose <strong>Properties</strong>.</li>
<li>On the <strong>Power Management</strong> tab, clear <em>Allow the computer to turn off this device to save power</em>.</li>
</ol>
<h3>3. Install pending updates</h3>
<p>Wireless driver fixes are delivered through Windows Update and the Software Center. Install everything that is pending, then restart.</p>
<h3>4. Note where it happens</h3>
<p>Meeting rooms with glass walls and the basement level have weaker coverage. If the drops only happen in one place, tell us the room or desk number so the network team can check the access point.</p>
<h3>Known issue</h3>
<p>Some 2023 laptops lose Wi-Fi after waking from sleep. A fixed driver is being rolled out; until then, turning Wi-Fi off and on again restores the connection.</p>`,
  },
  {
    key: 'password-reset',
    kb: 'help',
    category: 'Accounts & Security > Passwords',
    author: 'hannah.lee',
    title: 'Reset your password',
    meta: 'password, reset, forgot password, self-service, expired',
    views: 498,
    quality: 4.7,
    age: 380,
    featured: true,
    comments: [
      'So much faster than calling. Took two minutes.',
      'Remember to update the password on your phone too, my mail kept failing until I did.',
    ],
    html: `<p>You can reset your Northwind password yourself, at any time, without calling the Service Desk. You need the phone you registered for multi-factor authentication.</p>
<h3>If you know your current password</h3>
<ol>
<li>Go to <code>password.northwind.example</code> and sign in.</li>
<li>Select <strong>Change password</strong>, enter the current password and then the new one twice.</li>
<li>On Windows, lock your laptop (Windows key + L) and unlock it with the new password while on the office network or the VPN, so the laptop learns it.</li>
</ol>
<h3>If you forgot it</h3>
<ol>
<li>Go to <code>password.northwind.example</code> and select <strong>Forgot password</strong>.</li>
<li>Enter your email address and approve the request on your phone.</li>
<li>Choose a new password (see <em>Choose a strong passphrase</em>).</li>
<li>Wait two minutes before signing in elsewhere; the change takes a moment to reach every system.</li>
</ol>
<h3>After you change it</h3>
<ul>
<li>Update the password in the mail app on your phone and on any shared device you signed in to, such as a meeting room PC.</li>
<li>Outlook and Teams ask you to sign in again within the hour.</li>
</ul>
<p>Passwords expire every 180 days. You receive reminder emails 14, 7 and 1 day before.</p>`,
  },
  {
    key: 'account-locked',
    kb: 'help',
    category: 'Accounts & Security > Passwords',
    author: 'alex.rivera',
    title: 'Your account is locked: what to do',
    meta: 'locked out, account lockout, password, failed sign-in',
    views: 221,
    quality: 4.3,
    age: 140,
    html: `<p>Your account locks for 15 minutes after 10 failed sign-in attempts. It unlocks on its own, so you do not need to call anyone if you can wait.</p>
<h3>Why it happens</h3>
<p>Most lockouts are not caused by typing the wrong password. They come from a device that still uses your <strong>old</strong> password after you changed it and keeps retrying in the background:</p>
<ul>
<li>Mail on your phone or tablet</li>
<li>A mapped drive or saved credentials on a second computer</li>
<li>A meeting room or lab PC where you are still signed in</li>
</ul>
<h3>What to do</h3>
<ol>
<li>Wait 15 minutes, then sign in carefully once.</li>
<li>If you recently changed your password, update it on every device in the list above, or switch those devices off for an hour.</li>
<li>If you cannot remember the password, use <strong>Forgot password</strong> at <code>password.northwind.example</code>. A reset also unlocks the account.</li>
</ol>
<p>If your account locks again within a day, contact the Service Desk. We can see which device sends the failed attempts.</p>`,
  },
  {
    key: 'passphrase',
    kb: 'help',
    category: 'Accounts & Security > Passwords',
    author: 'fatima.alsayed',
    title: 'Choose a strong passphrase',
    meta: 'password policy, passphrase, password rules, security',
    views: 96,
    quality: 4.4,
    age: 250,
    html: `<p>Northwind passwords must be at least 14 characters long. The easiest way to meet the rule and still remember your password is a <strong>passphrase</strong>: four or more unrelated words.</p>
<h3>Rules the system checks</h3>
<ul>
<li>At least 14 characters</li>
<li>Not one of your last 12 passwords</li>
<li>Does not contain your name or user name</li>
<li>Not on the list of passwords exposed in public breaches</li>
</ul>
<h3>Tips</h3>
<ul>
<li>Pick words that do not belong together: <em>copper lantern otter tuesday</em> is better than a line from a song.</li>
<li>Spaces are allowed and count as characters.</li>
<li>Never reuse your Northwind password on another website.</li>
<li>Keep passwords for other work sites in the company password manager, available in the Software Center.</li>
</ul>
<h3>What not to do</h3>
<p>Do not write your password on a note near your desk, share it with a colleague, or send it by email or chat. The Service Desk will never ask you for your password.</p>`,
  },
  {
    key: 'mfa',
    kb: 'help',
    category: 'Accounts & Security > Multi-factor authentication',
    author: 'fatima.alsayed',
    title: 'Enrol in multi-factor authentication (MFA)',
    meta: 'mfa, 2fa, two-factor, authenticator app, security info',
    views: 302,
    quality: 4.5,
    age: 330,
    featured: true,
    html: `<p>Multi-factor authentication protects your account even if someone learns your password. Every employee enrols during their first week.</p>
<h3>What you need</h3>
<ul>
<li>Your laptop, signed in</li>
<li>A smartphone with an authenticator app (we recommend Microsoft Authenticator; any app that supports push notifications or 6-digit codes works)</li>
</ul>
<h3>Steps</h3>
<ol>
<li>Install the authenticator app on your phone from the App Store or Google Play.</li>
<li>On your laptop, go to <code>myaccount.northwind.example</code> and open <strong>Security info</strong>.</li>
<li>Select <strong>Add sign-in method</strong> and choose <strong>Authenticator app</strong>.</li>
<li>In the phone app, add a <strong>work or school account</strong> and scan the QR code shown on your laptop.</li>
<li>Approve the test notification.</li>
<li>Add a second method, such as a phone number for text messages, so you are not locked out if you lose your phone.</li>
</ol>
<h3>Day to day</h3>
<p>You are asked to approve sign-ins on new devices, outside the office network, and about every 30 days on your laptop. If you receive a request you did not start, <strong>deny it</strong> and tell the Service Desk: someone may know your password.</p>`,
  },
  {
    key: 'mfa-new-phone',
    kb: 'help',
    category: 'Accounts & Security > Multi-factor authentication',
    author: 'alex.rivera',
    title: 'Move MFA to a new phone',
    meta: 'mfa, new phone, lost phone, authenticator, temporary access pass',
    views: 158,
    quality: 4.1,
    age: 120,
    comments: ['Wish I had read this before trading in my old phone...'],
    html: `<p>Set up your new phone <strong>before</strong> you wipe or trade in the old one. It takes about five minutes.</p>
<h3>You still have the old phone</h3>
<ol>
<li>Install the authenticator app on the new phone.</li>
<li>On your laptop, open <code>myaccount.northwind.example</code> &gt; <strong>Security info</strong>.</li>
<li>Select <strong>Add sign-in method</strong> &gt; <strong>Authenticator app</strong> and scan the QR code with the new phone.</li>
<li>Approve the test notification on the new phone.</li>
<li>Make the new phone the <strong>default sign-in method</strong>, then delete the entry for the old phone.</li>
</ol>
<h3>The old phone is lost, broken or already reset</h3>
<ol>
<li>If you added a phone number as a backup method, sign in with a text-message code and follow the steps above.</li>
<li>Otherwise contact the Service Desk. Once we have verified your identity (a video call with your badge, or confirmation from your manager), we issue a temporary access pass valid for 8 hours.</li>
</ol>
<p>A lost company phone must also be reported so it can be wiped remotely.</p>`,
  },
  {
    key: 'mail-ios',
    kb: 'help',
    category: 'Devices > Mobile devices',
    author: 'jamal.wright',
    title: 'Set up company email on an iPhone or iPad',
    meta: 'iphone, ipad, ios, outlook mobile, email on phone, company portal',
    views: 233,
    quality: 4.4,
    age: 280,
    html: `<p>Company email, calendar and contacts on iPhone and iPad use the Outlook app. The built-in Mail app is not supported because it cannot apply the company security settings.</p>
<h3>Steps</h3>
<ol>
<li>Install <strong>Microsoft Outlook</strong> from the App Store.</li>
<li>Open Outlook and enter your Northwind email address.</li>
<li>Sign in with your password and approve the MFA request.</li>
<li>When prompted, install the <strong>Company Portal</strong> app and follow its steps to register the device. You only do this once; it lets IT protect company data on the phone.</li>
<li>Return to Outlook. Mail and calendar appear within a few minutes.</li>
</ol>
<h3>What IT can and cannot see</h3>
<p>Registration lets IT require a passcode and remove <em>company</em> data (mail, Teams, OneDrive) if the phone is lost. IT cannot see your photos, messages, browsing or personal apps, and cannot wipe a personal device.</p>
<h3>Troubleshooting</h3>
<ul>
<li><strong>"Your organization requires a PIN"</strong>: set a device passcode of at least 6 digits in iOS Settings.</li>
<li><strong>Calendar is empty</strong>: in Outlook settings, check that your account is switched on under <em>Calendar</em>.</li>
</ul>`,
  },
  {
    key: 'mail-android',
    kb: 'help',
    category: 'Devices > Mobile devices',
    author: 'jamal.wright',
    title: 'Set up company email on Android',
    meta: 'android, samsung, outlook mobile, work profile, email on phone',
    views: 141,
    quality: 4.0,
    age: 275,
    html: `<p>On Android phones and tablets, use the Outlook app for company email and calendar. Other mail apps cannot connect to company mailboxes.</p>
<h3>Steps</h3>
<ol>
<li>Install <strong>Microsoft Outlook</strong> and <strong>Company Portal</strong> from Google Play.</li>
<li>Open Company Portal, sign in with your Northwind email address and complete the registration. Allow the <strong>work profile</strong> when asked: it keeps work apps separate from personal ones.</li>
<li>Open Outlook from the work profile (apps with a small briefcase badge) and sign in.</li>
<li>Approve the MFA request.</li>
</ol>
<h3>Tips</h3>
<ul>
<li>You can pause the work profile in the evening or on holiday to silence work notifications.</li>
<li>Notifications missing? Check the battery optimisation settings and allow Outlook to run in the background.</li>
<li>Phones running Android 11 or older cannot register. Check under <em>Settings &gt; About phone</em>.</li>
</ul>`,
  },
  {
    key: 'out-of-office',
    kb: 'help',
    category: 'Email & Collaboration > Email and calendar',
    author: 'alex.rivera',
    title: 'Set an automatic out-of-office reply',
    meta: 'out of office, automatic reply, vacation, leave, outlook',
    views: 187,
    quality: 4.6,
    age: 365,
    html: `<p>Turn on automatic replies before you go on leave so people know when you are back and who to contact meanwhile.</p>
<h3>Outlook on Windows</h3>
<ol>
<li>Select <strong>File</strong> &gt; <strong>Automatic Replies</strong>.</li>
<li>Choose <strong>Send automatic replies</strong> and tick <strong>Only send during this time range</strong>.</li>
<li>Enter the start and end dates and times.</li>
<li>Write a message for people inside Northwind, then open the <strong>Outside My Organization</strong> tab and write a shorter one for external senders.</li>
<li>Select <strong>OK</strong>.</li>
</ol>
<h3>Outlook on the web or on a Mac</h3>
<p>Open <strong>Settings</strong> &gt; <strong>Mail</strong> &gt; <strong>Automatic replies</strong> (Mac: <strong>Tools</strong> &gt; <strong>Out of Office</strong>) and follow the same steps.</p>
<h3>A good message</h3>
<blockquote>Thank you for your message. I am out of the office until Monday 14 April with limited access to email. For urgent questions about the Austin office move, please contact Ava Jones.</blockquote>
<p>Leave travel plans and personal phone numbers out of the external message.</p>`,
  },
  {
    key: 'calendar-rooms',
    kb: 'help',
    category: 'Email & Collaboration > Email and calendar',
    author: 'priya.nair',
    title: 'Share your calendar and book meeting rooms',
    meta: 'calendar sharing, delegate, meeting room, room finder, booking',
    views: 109,
    quality: 4.2,
    age: 200,
    html: `<h3>Share your calendar</h3>
<ol>
<li>In Outlook, open the calendar and select <strong>Share</strong> (or right-click your calendar &gt; <em>Sharing permissions</em>).</li>
<li>Add the colleague and choose what they can see: <em>Can view when I'm busy</em>, <em>Can view titles and locations</em> or <em>Can view all details</em>.</li>
<li>To let an assistant manage meetings for you, choose <strong>Can edit</strong> or <strong>Delegate</strong>.</li>
</ol>
<p>Everyone at Northwind can already see when you are free or busy; sharing only adds detail.</p>
<h3>Book a meeting room</h3>
<ol>
<li>Create a meeting and add the attendees.</li>
<li>Select <strong>Room Finder</strong> (or the <em>Location</em> field) and pick the building and floor.</li>
<li>Free rooms are listed with their capacity and equipment (screen, video bar, whiteboard).</li>
<li>Add the room and send the invitation. The room accepts automatically when it is free.</li>
</ol>
<h3>Room rules</h3>
<ul>
<li>A booking is released automatically if nobody checks in on the room panel within 10 minutes of the start.</li>
<li>Recurring bookings are limited to 6 months.</li>
<li>Rooms for 12 people or more need approval from the office manager.</li>
</ul>`,
  },
  {
    key: 'meeting-av',
    kb: 'help',
    category: 'Email & Collaboration > Meetings',
    author: 'elena.petrova',
    title: 'Fix camera and microphone problems in video meetings',
    meta: 'teams, camera, microphone, audio, headset, video call',
    views: 176,
    quality: 4.3,
    age: 150,
    comments: ['The F8 key was my problem all along.'],
    html: `<p>If people cannot hear or see you, the usual cause is the wrong device selected or another app holding the camera. Check these in order.</p>
<ol>
<li><strong>Check the device settings in the meeting.</strong> In Teams select <strong>More</strong> (...) &gt; <strong>Settings</strong> &gt; <strong>Device settings</strong>. Pick the headset or microphone you actually use, and the right camera.</li>
<li><strong>Close other apps that use the camera</strong>, such as another meeting app or the camera app. Only one app can use the camera at a time.</li>
<li><strong>Check the privacy switch.</strong> Many laptops have a camera shutter or a function key (often F8 or F10) that turns the camera or microphone off.</li>
<li><strong>Allow access in the operating system.</strong>
<ul>
<li>Windows: <em>Settings &gt; Privacy &amp; security &gt; Camera</em> (and <em>Microphone</em>): allow desktop apps.</li>
<li>macOS: <em>System Settings &gt; Privacy &amp; Security &gt; Camera</em> (and <em>Microphone</em>): switch on Teams, then quit and reopen it.</li>
</ul></li>
<li><strong>Unplug and reconnect</strong> USB headsets and docks, then select the device again.</li>
<li><strong>Make a test call</strong> (Teams: <em>Device settings &gt; Make a test call</em>) to hear yourself back.</li>
</ol>
<p>Echo in a meeting room? Make sure only one laptop in the room has its microphone and speaker on.</p>`,
  },
  {
    key: 'printer-stuck',
    kb: 'help',
    category: 'Devices > Printers',
    author: 'jamal.wright',
    title: 'Printer troubleshooting: jobs stuck in the queue',
    meta: 'printer, printing, print queue, followme, stuck, paper jam',
    views: 274,
    quality: 3.8,
    age: 230,
    comments: ['Did not know jobs are deleted after 24 hours, that explains a lot.'],
    html: `<p>When you print and nothing comes out, the job is usually waiting at the printer, stuck in your laptop's queue, or sent to the wrong printer.</p>
<h3>1. Release the job at the printer</h3>
<p>Office printers use <strong>FollowMe</strong> printing: jobs wait until you tap your badge on any printer. Jobs that are not released within 24 hours are deleted.</p>
<h3>2. Check that you printed to FollowMe</h3>
<p>In the print dialog the printer should be <strong>NWL-FollowMe</strong>. Old direct printer names (for example <em>AUS-3F-LASER</em>) stopped working after the print upgrade; remove them from your device.</p>
<h3>3. Clear your local queue</h3>
<ol>
<li>Windows: open <strong>Settings &gt; Bluetooth &amp; devices &gt; Printers &amp; scanners</strong>, select NWL-FollowMe, then <strong>Open print queue</strong>.</li>
<li>Cancel jobs marked <em>Error</em> or that have been waiting for a long time.</li>
<li>Print a single test page.</li>
</ol>
<h3>4. Check the printer itself</h3>
<ul>
<li>Paper jam or empty tray: the screen shows where. Follow the steps on the display and never pull paper out of the hot fuser area.</li>
<li>Toner low: spare toner is in the supply cupboard on each floor. Log a ticket so we can reorder.</li>
</ul>
<h3>Still not printing?</h3>
<p>Report the printer name (the sticker on the front) and the message on its screen through the IT portal.</p>`,
  },
  {
    key: 'printer-add',
    kb: 'help',
    category: 'Devices > Printers',
    author: 'jamal.wright',
    title: 'Add the FollowMe printer to your laptop',
    meta: 'printer, add printer, followme, badge release, mac printing',
    views: 162,
    quality: 4.4,
    age: 225,
    html: `<p>NWL-FollowMe is one print queue for every office printer. Print once, then release the job at whichever printer is closest by tapping your badge.</p>
<h3>Windows</h3>
<ol>
<li>Connect to the office network or the VPN.</li>
<li>Open the <strong>Software Center</strong> and install <strong>FollowMe printing</strong>.</li>
<li>Restart any open applications. NWL-FollowMe now appears in the printer list.</li>
</ol>
<h3>macOS</h3>
<ol>
<li>Open <strong>Self Service</strong> and run <strong>Add FollowMe printer</strong>.</li>
<li>The first time you print, macOS asks for your Northwind user name and password. Tick <em>Remember this password</em>.</li>
</ol>
<h3>Releasing jobs</h3>
<ol>
<li>Tap your badge on the reader next to the printer screen.</li>
<li>Select the jobs to print, or <strong>Print all</strong>.</li>
<li>Choose <strong>Color</strong> only when you need it: the default is black and white, double-sided.</li>
</ol>
<p>Using your badge for the first time? The printer asks you to sign in once with your user name and password to link the badge.</p>`,
  },
  {
    key: 'laptop-setup',
    kb: 'help',
    category: 'Devices > Laptops',
    author: 'hannah.lee',
    title: 'Set up your new laptop',
    meta: 'new laptop, setup, first login, onboarding, autopilot, onedrive',
    views: 356,
    quality: 4.6,
    age: 190,
    featured: true,
    comments: ['Clear and complete. The checklist at the end is great.'],
    html: `<p>New Northwind laptops arrive ready to set themselves up. Allow about 45 minutes on a reliable network (office or home, not a phone hotspot).</p>
<h3>First start</h3>
<ol>
<li>Connect the charger and switch on.</li>
<li>Choose your language and keyboard, then connect to Wi-Fi (in the office, <strong>NWL-Guest</strong> is fine for this step).</li>
<li>Sign in with your Northwind email address and password and approve the MFA request.</li>
<li>Leave the laptop running while it installs apps and settings. Do not close the lid; it restarts by itself when needed.</li>
</ol>
<h3>Checklist when setup finishes</h3>
<ul>
<li>Sign in to <strong>Outlook</strong> and <strong>Teams</strong> and send a test message.</li>
<li>Open <strong>OneDrive</strong> and check that your files sync (a green tick on the folder).</li>
<li>Add the <strong>FollowMe printer</strong> (see the printing articles).</li>
<li>Install anything else you need from the <strong>Software Center</strong>.</li>
<li>Set up Windows Hello or Touch ID so you can sign in with your face or fingerprint.</li>
</ul>
<h3>Returning your old laptop</h3>
<p>Make sure everything is in OneDrive, then hand the old laptop to the IT bar or use the prepaid return label within two weeks. Do not reset it yourself: IT wipes it securely.</p>`,
  },
  {
    key: 'slow-computer',
    kb: 'help',
    category: 'Devices > Laptops',
    author: 'alex.rivera',
    title: 'Is your computer running slow? Checks to try first',
    meta: 'slow computer, performance, laptop slow, disk space, task manager',
    views: 321,
    quality: 4.1,
    age: 175,
    comments: [
      'Restart instead of shut down, who knew. Much better now.',
      'Could you add something about browser extensions?',
    ],
    html: `<p>Most slowdowns come from too many things running at once, a pending update or a full disk. These checks fix most cases in under 15 minutes.</p>
<ol>
<li><strong>Restart properly.</strong> Use <em>Restart</em>, not Shut down: Windows fast start-up keeps the previous session in memory. Laptops that have not restarted for a week get noticeably slower.</li>
<li><strong>Install pending updates.</strong> Open the Software Center and Windows Update, install everything and restart again.</li>
<li><strong>See what is using the computer.</strong> Press <code>Ctrl + Shift + Esc</code> for Task Manager (macOS: Activity Monitor) and sort by CPU and memory. Browsers with dozens of open tabs are the most common cause.</li>
<li><strong>Free up disk space.</strong> Keep at least 15% of the disk free. Empty Downloads and the Recycle Bin, and set OneDrive folders to <em>online-only</em> (right-click &gt; <em>Free up space</em>).</li>
<li><strong>Trim start-up apps.</strong> In Task Manager open <strong>Startup apps</strong> and disable anything you do not need straight away.</li>
<li><strong>Plug in the charger.</strong> On battery, laptops lower their performance to save power.</li>
</ol>
<h3>When to contact us</h3>
<p>If the laptop is still slow after these steps, or it is noisy and hot while idle, raise a ticket listing what you tried. Laptops older than four years are eligible for replacement.</p>`,
  },
  {
    key: 'docking',
    kb: 'help',
    category: 'Devices > Laptops',
    author: 'jamal.wright',
    title: 'Use a docking station and external monitors',
    meta: 'dock, docking station, monitor, external display, usb-c',
    views: 129,
    quality: 4.2,
    age: 110,
    html: `<p>Office desks have a USB-C dock with one cable to the laptop. That one cable gives you power, network, screens, keyboard and mouse.</p>
<h3>Connect</h3>
<ol>
<li>Plug the dock cable into the USB-C port marked with a lightning bolt or display symbol.</li>
<li>Wait up to 30 seconds for the screens to wake up.</li>
<li>Arrange the screens: Windows <em>Settings &gt; System &gt; Display</em>; macOS <em>System Settings &gt; Displays</em>. Drag them to match how they sit on the desk.</li>
</ol>
<h3>If a screen stays black</h3>
<ul>
<li>Press the input button on the monitor and select the input the dock is connected to (often DisplayPort).</li>
<li>Unplug the dock cable from the laptop for 10 seconds, then plug it back in.</li>
<li>Restart with the laptop already connected to the dock.</li>
<li>MacBooks with M1 or M2 chips drive only one external screen through a dock. This is a hardware limit.</li>
</ul>
<h3>Laptop not charging on the dock</h3>
<p>Check that the dock's own power supply is plugged in. Docks marked <strong>65W</strong> charge standard laptops; performance laptops need the 100W docks in the engineering areas.</p>`,
  },
  {
    key: 'software-request',
    kb: 'help',
    category: 'Software & Access',
    author: 'elena.petrova',
    title: 'Request new software',
    meta: 'software request, install software, license, application, approval',
    views: 238,
    quality: 4.0,
    age: 260,
    featured: true,
    html: `<p>Northwind keeps a catalog of approved software. Many titles install straight away; licensed or specialist software needs approval first.</p>
<h3>1. Check the Software Center first</h3>
<p>Open the <strong>Software Center</strong> (Windows) or <strong>Self Service</strong> (macOS). Everything listed there is already approved: select <strong>Install</strong> and it is ready in a few minutes, with no ticket needed.</p>
<h3>2. Request it from the IT portal</h3>
<ol>
<li>Open the IT portal and choose <strong>Request something &gt; Software</strong>.</li>
<li>Search for the product. If it is in the catalog, choose the edition and explain why you need it.</li>
<li>Your manager approves the request. Licensed products also need approval from the software asset team.</li>
<li>Once approved, the software appears in the Software Center or is installed for you.</li>
</ol>
<h3>3. Not in the catalog?</h3>
<p>Choose <strong>Request new software (not listed)</strong>. Information Security reviews new software for data protection and licensing, which usually takes 5 to 10 working days. Include a link to the vendor's website and the number of people who need it.</p>
<p>Please do not install software from the internet yourself: unapproved software is removed automatically.</p>`,
  },
  {
    key: 'software-center',
    kb: 'help',
    category: 'Software & Access',
    author: 'elena.petrova',
    title: 'Install approved software from the Software Center',
    meta: 'software center, self service, install app, failed install',
    views: 167,
    quality: 4.5,
    age: 255,
    html: `<p>The Software Center lists every application you can install without a request.</p>
<h3>Windows</h3>
<ol>
<li>Open the Start menu and type <strong>Software Center</strong>.</li>
<li>Select <strong>Applications</strong>, find the program and choose <strong>Install</strong>.</li>
<li>Keep the laptop on and connected until the status changes to <em>Installed</em>.</li>
</ol>
<h3>macOS</h3>
<ol>
<li>Open <strong>Self Service</strong> from the Applications folder.</li>
<li>Find the app and select <strong>Install</strong>.</li>
</ol>
<h3>If an installation fails</h3>
<ul>
<li>Restart and try again: a pending update often blocks new installs.</li>
<li>Check that you have at least 10 GB of free disk space.</li>
<li>Error <em>0x87D00607</em> means the content could not be downloaded. Connect to the office network or the VPN and retry.</li>
</ul>
<p>Popular items include a PDF reader, a file archiver, a code editor, the FollowMe printer and the company password manager.</p>`,
  },
  {
    key: 'phishing',
    kb: 'help',
    category: 'Accounts & Security > Phishing and safe computing',
    author: 'fatima.alsayed',
    title: 'Recognise and report phishing emails',
    meta: 'phishing, scam, suspicious email, report phishing, security',
    views: 289,
    quality: 4.8,
    age: 340,
    featured: true,
    comments: ['The hover tip saved me last week, the link went to a strange domain.'],
    html: `<p>Phishing emails try to make you click a link, open an attachment or share information. They are the most common way attackers get into companies, and they are getting harder to spot.</p>
<h3>Warning signs</h3>
<ul>
<li><strong>Urgency or pressure</strong>: "your account will be closed today", "the CEO needs this now".</li>
<li><strong>Unexpected requests</strong> for passwords, MFA codes, gift cards or changes to bank details.</li>
<li><strong>A sender that looks almost right</strong>, such as <code>northwind-labs.co</code>, or a display name that does not match the address.</li>
<li><strong>Links that go somewhere else</strong>: hover over a link (without clicking) to see the real address.</li>
<li>An <strong>[EXTERNAL]</strong> tag on a message that claims to come from a colleague.</li>
</ul>
<h3>How to report</h3>
<ol>
<li>In Outlook select <strong>Report</strong> &gt; <strong>Report phishing</strong>. The message goes to the security team and disappears from your inbox.</li>
<li>Do not forward it to colleagues to ask what they think.</li>
</ol>
<h3>If you already clicked</h3>
<p>Speed matters more than blame. Change your password at <code>password.northwind.example</code> and call the Service Desk straight away. If you approved an MFA request you did not start, say so: the security team can end active sessions.</p>`,
  },
  {
    key: 'share-files',
    kb: 'help',
    category: 'Email & Collaboration > Files and sharing',
    author: 'fatima.alsayed',
    title: 'Share files securely with people outside Northwind',
    meta: 'share files, external sharing, onedrive, sensitivity label, data protection',
    views: 118,
    quality: 4.2,
    age: 130,
    html: `<p>Use OneDrive or a Teams channel to share files with customers and partners. Do not send confidential documents as email attachments.</p>
<h3>Share a file from OneDrive</h3>
<ol>
<li>Right-click the file and choose <strong>Share</strong>.</li>
<li>Open the link settings and choose <strong>Specific people</strong>.</li>
<li>Enter the external person's email address.</li>
<li>Switch off <strong>Allow editing</strong> if they only need to read it.</li>
<li>Set an <strong>expiration date</strong> for anything sensitive.</li>
</ol>
<p>The recipient gets a one-time code by email to open the file. You can see and remove access at any time under <em>Manage access</em>.</p>
<h3>Check the label first</h3>
<table>
<tr><th>Label</th><th>Can it be shared externally?</th></tr>
<tr><td>Public</td><td>Yes</td></tr>
<tr><td>Internal</td><td>Only with partners covered by an NDA</td></tr>
<tr><td>Confidential</td><td>Only with specific people, with an expiry date</td></tr>
<tr><td>Restricted</td><td>No. Ask the data owner.</td></tr>
</table>
<p>Never upload company files to personal cloud storage or file transfer websites.</p>`,
  },
  {
    key: 'onedrive-restore',
    kb: 'help',
    category: 'Email & Collaboration > Files and sharing',
    author: 'elena.petrova',
    title: 'Back up and restore your files with OneDrive',
    meta: 'backup, restore, deleted file, version history, onedrive, recycle bin',
    views: 135,
    quality: 4.4,
    age: 205,
    html: `<p>On Northwind laptops, files in your Desktop, Documents and Pictures folders are backed up to OneDrive automatically. Files saved anywhere else (for example <code>C:\\Temp</code>) are not backed up.</p>
<h3>Check that your backup works</h3>
<ul>
<li>Select the OneDrive cloud icon in the taskbar or menu bar. It should say <strong>Your files are synced</strong>.</li>
<li>A red cross or a paused icon means files are not being backed up: select the icon to see why.</li>
</ul>
<h3>Restore a deleted file</h3>
<ol>
<li>Go to <code>onedrive.northwind.example</code> and open the <strong>Recycle bin</strong>.</li>
<li>Select the file and choose <strong>Restore</strong>. Deleted files are kept for 93 days.</li>
</ol>
<h3>Restore an earlier version</h3>
<ol>
<li>Right-click the file in OneDrive and choose <strong>Version history</strong>.</li>
<li>Pick the version from before the change and select <strong>Restore</strong>.</li>
</ol>
<h3>Many files changed at once?</h3>
<p>If lots of files were renamed or encrypted suddenly, disconnect from the network and call the Service Desk. OneDrive can restore your whole library to a point in time within the last 30 days.</p>`,
  },
  {
    key: 'remote-work',
    kb: 'help',
    category: 'Getting Started',
    author: 'hannah.lee',
    title: 'Working remotely: a checklist',
    meta: 'remote work, work from home, travel, hybrid, checklist',
    views: 194,
    quality: 4.3,
    age: 150,
    html: `<p>Working from home or on the road? Run through this list before you leave the office so nothing stops you on the first morning.</p>
<h3>Before you go</h3>
<ul>
<li>Restart your laptop and install pending updates while you are on the fast office network.</li>
<li>Check that the VPN connects (see <em>Connect to the corporate VPN</em>).</li>
<li>Make sure MFA works on your phone and that you have a backup method.</li>
<li>Pack the charger: spare chargers are not available at short notice.</li>
</ul>
<h3>At home</h3>
<ul>
<li>Use a wired connection for long video calls when you can; it is more stable than Wi-Fi.</li>
<li>Lock your screen (Windows key + L, or Control + Command + Q on a Mac) whenever you step away, even at home.</li>
<li>Do not let family members use your work laptop.</li>
<li>Print only when necessary, and never leave company documents in a home printer tray.</li>
</ul>
<h3>Travelling abroad</h3>
<p>Tell the Service Desk at least five working days before you travel outside your home country. Some destinations require a loan laptop, and VPN access may be restricted.</p>`,
  },
  {
    key: 'service-desk',
    kb: 'help',
    category: 'Getting Started',
    author: 'priya.nair',
    title: 'Get help from the IT Service Desk',
    meta: 'service desk, help desk, contact it, support hours, ticket',
    views: 210,
    quality: 4.5,
    age: 400,
    featured: true,
    html: `<p>The Service Desk is the single point of contact for IT questions and problems. Choose the channel that matches how urgent your issue is.</p>
<table>
<tr><th>Channel</th><th>Best for</th><th>Hours</th></tr>
<tr><td>IT portal</td><td>Requests and non-urgent issues; you can follow progress</td><td>Always open</td></tr>
<tr><td>Chat in the portal</td><td>Quick questions</td><td>Monday to Friday, 7:00 to 19:00 local time</td></tr>
<tr><td>Phone, extension 4357 (HELP)</td><td>Urgent issues: you cannot work, or a security concern</td><td>24 hours, every day</td></tr>
<tr><td>IT bar (Austin and London)</td><td>Hardware swaps and laptop pickups</td><td>Monday to Friday, 9:00 to 17:00</td></tr>
</table>
<h3>Get a faster answer</h3>
<ul>
<li>Search the knowledge base first: many common fixes take a few minutes.</li>
<li>Describe what you were doing, what happened and when it started.</li>
<li>Attach a screenshot of any error message.</li>
<li>Say how many people are affected; problems that stop a team are prioritised.</li>
</ul>
<h3>Response times</h3>
<p>We aim to respond to urgent incidents within 30 minutes and to standard requests within one working day. You receive an email with a ticket number that you can reply to.</p>`,
  },
  // ------------------------------------------------------------------ IT Runbooks (agents only)
  {
    key: 'rb-identity',
    kb: 'runbooks',
    category: 'Service Desk Procedures',
    author: 'priya.nair',
    title: "Runbook: verify a caller's identity before a password reset",
    meta: 'identity verification, password reset, social engineering, service desk procedure',
    views: 147,
    quality: 4.7,
    age: 320,
    html: `<p>Never reset a password, unlock an account or issue a temporary MFA pass until the caller's identity is verified. Attackers regularly call service desks pretending to be employees, often posing as senior staff in a hurry.</p>
<h3>Verification options (use one)</h3>
<ol>
<li><strong>Video call with badge:</strong> start a Teams video call, compare the caller with the directory photo and ask them to show their badge.</li>
<li><strong>Manager confirmation:</strong> call the user's manager on the number in the directory (never a number the caller gives you) and ask them to confirm.</li>
<li><strong>In person:</strong> at the IT bar, with the badge.</li>
</ol>
<p>Knowledge questions (date of birth, employee number) are <strong>not</strong> enough on their own: that information is easy to find.</p>
<h3>Then</h3>
<ol>
<li>Record the verification method in the work notes of the incident.</li>
<li>For a password reset, set a one-time password and tick <em>User must change password at next sign-in</em>.</li>
<li>For a lost MFA device, issue a temporary access pass (8 hours), never a permanent bypass.</li>
<li>Send the one-time password through a second channel (SMS to the directory number), not to the caller on the same call.</li>
</ol>
<h3>Red flags</h3>
<p>Pressure to skip steps, requests for an executive's account, or a caller on a personal number. Pause the request, involve Information Security and log a security incident.</p>`,
  },
  {
    key: 'rb-vpn-gateway',
    kb: 'runbooks',
    category: 'Network Operations',
    author: 'marcus.chen',
    title: 'Runbook: VPN gateway health check and failover',
    meta: 'vpn gateway, failover, load balancer, network operations, outage',
    views: 64,
    quality: 4.4,
    age: 140,
    html: `<p>Use this runbook when several users report VPN connection failures at the same time, or when monitoring raises a gateway alert.</p>
<h3>1. Confirm the scope</h3>
<ul>
<li>Check the monitoring dashboard for <strong>vpn-gw-aus-01</strong> and <strong>vpn-gw-lon-01</strong>: CPU, session count and tunnel errors.</li>
<li>Look for related incidents from the last 30 minutes. Three or more from different locations points to a gateway problem rather than a user problem.</li>
</ul>
<h3>2. Quick checks</h3>
<ol>
<li>Session count close to the licence limit (2,000 per gateway)? Declare a major incident; extra licences are on the emergency purchase list.</li>
<li>Certificate expiry: the gateway certificate is renewed every 12 months. An expired certificate shows as <em>TLS handshake failed</em> on every client.</li>
<li>Authentication: if sign-in fails but tunnels are healthy, test the identity provider with the monitoring test account.</li>
</ol>
<h3>3. Fail over</h3>
<ol>
<li>Announce the failover in the network operations channel.</li>
<li>In the global load balancer, drain the unhealthy gateway (weight 0). Existing sessions stay up; new sessions go to the healthy gateway.</li>
<li>Watch the session count move over for 10 minutes.</li>
<li>Restart the drained gateway service only once its session count reaches zero.</li>
</ol>
<h3>4. Close out</h3>
<p>Restore the original weights, attach the graphs to the incident, and open a problem record if the root cause is unknown.</p>`,
  },
  {
    key: 'rb-reimage',
    kb: 'runbooks',
    category: 'Endpoint Management',
    author: 'jamal.wright',
    title: 'Runbook: reimage a laptop',
    meta: 'reimage, wipe, rebuild laptop, device management, endpoint',
    views: 88,
    quality: 4.3,
    age: 180,
    html: `<p>Reimage a laptop when it has a persistent operating system fault, after malware clean-up, or before it goes to a new user. A reimage removes all local data.</p>
<h3>Before you start</h3>
<ul>
<li>Confirm with the user that OneDrive shows all files synced, including folders outside Desktop, Documents and Pictures.</li>
<li>Note any locally installed software that is not in the Software Center.</li>
<li>After a security incident, wait until Information Security has collected what it needs.</li>
</ul>
<h3>Steps</h3>
<ol>
<li>In the device management console, find the device by serial number and select <strong>Wipe</strong> with <em>Retain enrollment</em> cleared.</li>
<li>Wait for the device to restart into setup (15 to 30 minutes on a wired network).</li>
<li>When the device shows <em>Ready for setup</em>, assign it to the user in the console.</li>
<li>Hand the laptop over, or let the user complete the first sign-in remotely using <em>Set up your new laptop</em>.</li>
</ol>
<h3>Verify</h3>
<ul>
<li>Disk encryption shows as enabled in the console.</li>
<li>Compliance status is <strong>Compliant</strong> within 2 hours.</li>
<li>The asset record shows the user, the status and the reimage date.</li>
</ul>`,
  },
  {
    key: 'rb-print-server',
    kb: 'runbooks',
    category: 'Endpoint Management',
    author: 'jamal.wright',
    title: 'Runbook: clear a stuck print server queue',
    meta: 'print server, spooler, followme, print queue, outage',
    views: 52,
    quality: 4.0,
    age: 90,
    html: `<p>Use this when FollowMe jobs do not appear at any printer, or users in several areas report that printing hangs.</p>
<ol>
<li><strong>Check the scope.</strong> If only one printer is affected, it is a device problem (paper, toner, network cable), not the print server.</li>
<li><strong>Look at the queue</strong> on <code>print-aus-01</code> in Print Management. A job in <em>Error</em> at the top of the queue can block everything behind it.</li>
<li><strong>Delete the blocking job</strong> and check whether the queue starts moving.</li>
<li>If the queue is still frozen, <strong>restart the spooler</strong>:
<pre>Restart-Service -Name Spooler -Force</pre>
Then restart the FollowMe release service from the Services console.</li>
<li><strong>Test</strong> by printing a page to NWL-FollowMe and releasing it at the nearest printer.</li>
</ol>
<h3>If the spooler keeps crashing</h3>
<p>A faulty driver is the usual cause. Check the PrintService/Admin event log for the driver name, move the affected printers to the standard universal driver, and raise a problem record.</p>
<p>Tell users in the incident that they can keep printing and that jobs sent during the outage may need to be sent again.</p>`,
  },
  {
    key: 'rb-major-comms',
    kb: 'runbooks',
    category: 'Major Incidents',
    author: 'priya.nair',
    title: 'Runbook: major incident communication checklist',
    meta: 'major incident, communication, status update, bridge call, stakeholders',
    views: 73,
    quality: 4.6,
    age: 210,
    html: `<p>Clear, regular communication matters as much as the fix. Use this checklist from the moment a major incident is declared.</p>
<h3>First 15 minutes</h3>
<ul>
<li>Declare the major incident and open a bridge call. Post the bridge link in the incident.</li>
<li>Assign the roles: incident manager, technical lead, communications lead and scribe.</li>
<li>Send the first notification to affected users: what is affected, since when, what to do meanwhile, and when the next update comes.</li>
</ul>
<h3>Every 30 minutes</h3>
<ul>
<li>Send an update even when nothing has changed. Silence creates more calls to the Service Desk.</li>
<li>Update the portal banner so users see the status before they raise a ticket.</li>
<li>Brief the Service Desk on what to say, and link new incidents as children of the major incident.</li>
</ul>
<h3>Writing updates</h3>
<ul>
<li>Use plain language and no internal system names.</li>
<li>Say what users <em>can</em> do: workarounds, alternatives, who to call for urgent needs.</li>
<li>Never promise a fix time you are unsure of; give the time of the next update instead.</li>
</ul>
<h3>After resolution</h3>
<p>Send a resolution message, confirm with a few affected users that the service is back, and schedule the post-incident review within five working days.</p>`,
  },
  {
    key: 'rb-onboarding',
    kb: 'runbooks',
    category: 'Identity & Access',
    author: 'fatima.alsayed',
    title: 'Runbook: onboard a new employee (accounts and access)',
    meta: 'onboarding, new joiner, accounts, access, licence, starter',
    views: 96,
    quality: 4.5,
    age: 240,
    html: `<p>Accounts for new joiners are created from the HR start record. This runbook covers what the Service Desk checks and completes in the week before the start date.</p>
<h3>Five working days before</h3>
<ol>
<li>Confirm the account exists in the directory with the right department, manager and location.</li>
<li>Check that group memberships match the role template for the job title. Extra access needs a request approved by the manager.</li>
<li>Assign the licence bundle (standard or engineering).</li>
<li>Allocate a laptop and register it to the new user in the device management console.</li>
</ol>
<h3>On the first day</h3>
<ul>
<li>Give the new joiner a temporary password through their manager, never by email.</li>
<li>Walk them through MFA enrolment, then laptop setup.</li>
<li>Confirm they can sign in to email, Teams and the IT portal.</li>
</ul>
<h3>Common issues</h3>
<ul>
<li><strong>Start date moved:</strong> the account stays disabled until the HR record changes. Do not enable it manually.</li>
<li><strong>Contractor:</strong> set an account expiry date that matches the end of the contract.</li>
</ul>`,
  },
  {
    key: 'rb-offboarding',
    kb: 'runbooks',
    category: 'Identity & Access',
    author: 'fatima.alsayed',
    title: 'Runbook: offboard a leaver',
    meta: 'offboarding, leaver, disable account, revoke access, mailbox',
    views: 81,
    quality: 4.4,
    age: 235,
    html: `<p>Access must be removed on the leaver's last working day. For dismissals, HR may ask for immediate removal: treat that as urgent.</p>
<h3>On the last day</h3>
<ol>
<li>Disable the account at the agreed time (end of day unless HR says otherwise).</li>
<li>Revoke active sessions and MFA methods so signed-in devices are logged out.</li>
<li>Convert the mailbox to a shared mailbox and, if requested, give the manager access for 90 days.</li>
<li>Transfer ownership of the user's OneDrive files to the manager.</li>
<li>Remove the user from groups that grant administrative or financial access.</li>
<li>Wipe company data from mobile devices.</li>
</ol>
<h3>Hardware</h3>
<p>Collect the laptop, badge and any loan equipment, and update the asset records to <em>In stock</em> or <em>Awaiting reimage</em>.</p>
<h3>After 90 days</h3>
<p>Delete the account and release its licences. Keep the record of these steps in the request for audit purposes.</p>`,
  },
  {
    key: 'ke-wifi-sleep',
    kb: 'runbooks',
    category: 'Known Errors',
    author: 'ravi.menon',
    title: 'Known error: laptops lose Wi-Fi after waking from sleep',
    meta: 'known error, wifi, sleep, modern standby, wireless driver, workaround',
    views: 58,
    quality: 4.2,
    age: 45,
    table: 'kb_template_known_error_article',
    fields: {
      kb_description:
        '<p>Some 2023 model laptops show no Wi-Fi networks after waking from sleep. The wireless adapter stays disabled until the laptop restarts. Only Windows 11 laptops with wireless driver 22.1.0 are affected.</p>',
      kb_workaround:
        '<ol><li>Turn Wi-Fi off and on again from the quick settings panel.</li><li>If no networks appear, open Device Manager, right-click the wireless adapter, choose <strong>Disable device</strong>, then <strong>Enable device</strong>.</li><li>As a last resort, restart the laptop.</li></ol><p>Agents: link affected incidents to the problem record and do not replace hardware for this symptom.</p>',
      kb_cause:
        '<p>Driver 22.1.0 does not restore power to the adapter after modern standby. Version 22.3.0 fixes it and is being deployed through the Software Center in waves.</p>',
    },
  },
];
