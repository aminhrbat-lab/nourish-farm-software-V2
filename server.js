const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');

const app = express();
const port = process.env.SERVER_PORT || 3000;
const JWT_SECRET = 'nourish_super_secret_key_2026';

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser());
app.set('view engine', 'ejs');

// Layout Setup
app.use(expressLayouts);
app.set('layout', 'partials/layout');

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_FILE = path.join(dataDir, 'employees.json');
const LEAVE_FILE = path.join(dataDir, 'leave-applications.json');
const USERS_FILE = path.join(dataDir, 'users.json');

// ==========================================
// 📁 DATABASE FUNCTIONS
// ==========================================
function loadDB() { if (!fs.existsSync(DB_FILE)) return []; return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function loadLeaveDB() { if (!fs.existsSync(LEAVE_FILE)) return []; return JSON.parse(fs.readFileSync(LEAVE_FILE, 'utf-8')); }
function saveLeaveDB(data) { fs.writeFileSync(LEAVE_FILE, JSON.stringify(data, null, 2)); }
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const defaultAdmin = { _id: 'u1', employeeId: 'admin', name: 'Super Admin', password: bcrypt.hashSync('admin123', 10), role: 'Admin', farmCC: '' };
    fs.writeFileSync(USERS_FILE, JSON.stringify([defaultAdmin], null, 2));
    return [defaultAdmin];
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}
function saveUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }

function fixMissingIds() {
  let db = loadDB(); let changed = false;
  db.forEach(emp => { if (!emp._id) { emp._id = 'emp_' + Date.now() + Math.floor(Math.random() * 10000); changed = true; } });
  if (changed) saveDB(db);
}
fixMissingIds();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// ==========================================
// 🔐 AUTH MIDDLEWARES
// ==========================================
const ensureAuth = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; res.locals.user = decoded; next();
  } catch (err) { res.clearCookie('token'); res.redirect('/login'); }
};

const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).send("Access Denied");
    next();
  };
};

// ==========================================
// 🧠 LEAVE ENGINE
// ==========================================
function getCasualLeaveEntitlement(joiningDateStr) {
  if (!joiningDateStr) return 0;
  const joiningDate = new Date(joiningDateStr);
  let month = joiningDate.getMonth() + 1; let day = joiningDate.getDate();
  if (day > 15) { month = month + 1; if (month > 12) month = 1; }
  let entitle = Math.ceil((10 / 12) * (12 - month));
  return Math.max(0, entitle);
}
function getPclEntitlement(joiningDateStr) {
  if (!joiningDateStr) return 0;
  const joiningDate = new Date(joiningDateStr);
  let month = joiningDate.getMonth() + 1; let day = joiningDate.getDate();
  let joiningMonthPcl = 0;
  if (day >= 26 || day <= 3) joiningMonthPcl = 4;
  else if (day >= 4 && day <= 17) joiningMonthPcl = 2;
  else if (day >= 18 && day <= 25) joiningMonthPcl = 1;
  let remainingMonths = 12 - month;
  if (day > 25) remainingMonths = 11 - month; 
  if (remainingMonths < 0) remainingMonths = 0;
  let total = joiningMonthPcl + (4 * remainingMonths);
  return Math.min(total, 52);
}
function getEarnLeaveAccrued(workingDays) { return Math.min(Math.floor(workingDays / 18), 16); }

function getLeaveBalance(emp, year, leaveType) {
  let leaveDb = loadLeaveDB();
  let entitlements = {
    'Project Casual Leave': getPclEntitlement(emp.joiningDate),
    'Casual Leave': getCasualLeaveEntitlement(emp.joiningDate),
    'Medical Leave': 14, 'Marriage Leave': 5, 'Paternity Leave': 3, 'Hajj Leave': 45,
    'Omrah Leave': 10, 'Bereavement Leave': 3, 'Earn Leave': getEarnLeaveAccrued(emp.workingDays || 0)
  };
  let carryForward = (leaveType === 'Earn Leave') ? (emp.carryForwardEL || 0) : 0;
  let totalEntitlement = entitlements[leaveType] + carryForward;
  let used = 0;
  leaveDb.forEach(app => {
    if (app.employeeId === emp.employeeId && app.leaveType === leaveType && app.status === 'Submitted') {
      if (new Date(app.fromDate).getFullYear() === parseInt(year)) used += app.totalDays;
    }
  });
  return { entitlement: entitlements[leaveType], carryForward, totalEntitlement, used, remaining: totalEntitlement - used };
}

// ==========================================
// 🔐 LOGIN & USER ROUTES
// ==========================================
app.get('/login', (req, res) => res.render('login', { error: null, layout: false }));
app.post('/login', (req, res) => {
  const { employeeId, password } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.employeeId === employeeId);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: "Invalid Employee ID or Password", layout: false });
  }
  const token = jwt.sign({ _id: user._id, employeeId: user.employeeId, name: user.name, role: user.role, farmCC: user.farmCC }, JWT_SECRET, { expiresIn: '1d' });
  res.cookie('token', token, { httpOnly: true });
  res.redirect('/');
});
app.get('/logout', (req, res) => { res.clearCookie('token'); res.redirect('/login'); });

app.get('/admin/users', ensureAuth, restrictTo('Admin'), (req, res) => {
  const users = loadUsers();
  res.render('admin-users', { users, currentPath: '/admin/users', pageTitle: 'User Management' });
});

app.post('/admin/users/add', ensureAuth, restrictTo('Admin'), (req, res) => {
  const { employeeId, name, password, role, farmCC } = req.body;
  let users = loadUsers();
  if (users.find(u => u.employeeId === employeeId)) return res.send("User already exists! <a href='/admin/users'>Go Back</a>");
  users.push({ _id: 'u_' + Date.now(), employeeId, name, password: bcrypt.hashSync(password, 10), role, farmCC: (role === 'Farm Incharge' || role === 'Farm Store Incharge') ? farmCC : '' });
  saveUsers(users);
  res.redirect('/admin/users');
});

// ==========================================
// ১. DASHBOARD & EMPLOYEE ROUTES
// ==========================================
app.get('/', ensureAuth, (req, res) => res.render('index', { currentPath: '/', pageTitle: 'Dashboard' }));

app.post('/upload', ensureAuth, restrictTo('Admin'), upload.single('excelFile'), (req, res) => {
  if (!req.file) return res.redirect('/');
  const workbook = XLSX.readFile(req.file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);
  let db = loadDB();
  rows.forEach(row => {
    const empId = String(row['Employee ID'] || row['Emp ID'] || row['EmployeeID'] || '').trim();
    if (!empId) return;
    const existing = db.find(e => e.employeeId === empId);
    const newEmp = {
      _id: existing ? existing._id : 'emp_' + Date.now() + Math.floor(Math.random() * 1000),
      employeeId: empId, employeeName: row['Employee Name'] || row['Emp Name'] || '',
      designation: row['Designation'] || '', department: row['Department'] || '',
      joiningDate: row['Joining Date'] || row['Date of Joining'] || '',
      farmCC: row['Farm CC'] || row['CC'] || '', farmName: row['Farm Name'] || row['CC Name'] || '',
      currentStatus: row['Current Status'] || 'Active',
      workingDays: existing ? existing.workingDays : 0, carryForwardEL: existing ? existing.carryForwardEL : 0,
      inactiveDate: '', absentFrom: '', absentTo: '', absentTillNow: false, transferHistory: []
    };
    if (existing) Object.assign(existing, newEmp, { _id: existing._id });
    else db.push(newEmp);
  });
  saveDB(db); fs.unlinkSync(req.file.path); res.redirect('/');
});

app.get('/search', ensureAuth, (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const db = loadDB();
  let results = db.filter(e => (e.employeeId && e.employeeId.toLowerCase().includes(q.toLowerCase())) || (e.employeeName && e.employeeName.toLowerCase().includes(q.toLowerCase())));
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') results = results.filter(e => String(e.farmCC) === String(req.user.farmCC));
  else if (req.user.role === 'General Employee') results = results.filter(e => e.employeeId === req.user.employeeId);
  res.render('search', { query: q, results, currentPath: '/search', pageTitle: 'Search Results' });
});

app.post('/update/:id', ensureAuth, (req, res) => {
  const id = req.params.id; const db = loadDB();
  const emp = db.find(e => e._id === id || e.employeeId === id);
  if (!emp) return res.redirect('/');
  if ((req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') && String(emp.farmCC) !== String(req.user.farmCC)) return res.status(403).send("Access Denied");
  
  const { employeeName, employeeId, currentStatus, workingDays, carryForwardEL } = req.body;
  if (employeeName) emp.employeeName = employeeName;
  if (employeeId !== undefined) emp.employeeId = employeeId;
  if (workingDays !== undefined) emp.workingDays = Number(workingDays);
  if (carryForwardEL !== undefined) emp.carryForwardEL = Number(carryForwardEL);
  if (currentStatus) emp.currentStatus = currentStatus;
  if (currentStatus === 'Absent') { emp.absentFrom = req.body.absentFrom || ''; emp.absentTillNow = req.body.absentTillNow === 'on'; emp.absentTo = emp.absentTillNow ? 'Till Now' : (req.body.absentTo || ''); }
  if (currentStatus === 'Transfer') {
    if (req.body.transferFarmName) emp.farmName = req.body.transferFarmName;
    if (req.body.transferFarmCC) emp.farmCC = req.body.transferFarmCC;
    if (req.body.transferDesignation) emp.designation = req.body.transferDesignation;
    if (req.body.transferDepartment) emp.department = req.body.transferDepartment;
    emp.currentStatus = 'Active';
    if (!emp.transferHistory) emp.transferHistory = [];
    emp.transferHistory.push({ date: req.body.transferDate, farmName: emp.farmName, farmCC: emp.farmCC, designation: emp.designation, department: emp.department });
  }
  saveDB(db); res.redirect('/search?q=' + encodeURIComponent(emp.employeeName));
});

app.get('/active', ensureAuth, (req, res) => {
  const db = loadDB(); const selectedFarm = req.query.farm || '';
  const farms = [...new Set(db.filter(e => e.farmName).map(e => e.farmName))];
  let list = db.filter(e => e.currentStatus === 'Active');
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') list = list.filter(e => String(e.farmCC) === String(req.user.farmCC));
  else if (selectedFarm) list = list.filter(e => e.farmName === selectedFarm);
  res.render('active', { list, farms, selectedFarm, currentPath: '/active', pageTitle: 'Active Employees' });
});

app.get('/inactive', ensureAuth, (req, res) => {
  const db = loadDB(); let list = db.filter(e => e.currentStatus === 'Inactive');
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') list = list.filter(e => String(e.farmCC) === String(req.user.farmCC));
  res.render('inactive', { list, month: req.query.month || '', currentPath: '/inactive', pageTitle: 'Inactive Employees' });
});

app.get('/absent', ensureAuth, (req, res) => {
  const db = loadDB(); let list = db.filter(e => e.currentStatus === 'Absent');
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') list = list.filter(e => String(e.farmCC) === String(req.user.farmCC));
  res.render('absent', { list, currentPath: '/absent', pageTitle: 'Absent Employees' });
});

app.get('/transfer', ensureAuth, (req, res) => {
  const db = loadDB(); const list = [];
  db.forEach(e => { 
    if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') if (String(e.farmCC) !== String(req.user.farmCC)) return;
    (e.transferHistory || []).forEach(t => list.push({ employeeId: e.employeeId || 'Pending', employeeName: e.employeeName, transferDate: t.date, farmName: t.farmName, farmCC: t.farmCC, designation: t.designation, department: t.department })); 
  });
  res.render('transfer', { list, currentPath: '/transfer', pageTitle: 'Transfer List' });
});

// ==========================================
// ২. JOINING MODULE
// ==========================================
app.get('/joining', ensureAuth, restrictTo('Admin', 'Farm Incharge', 'Farm Store Incharge'), (req, res) => {
  const db = loadDB();
  const designations = [...new Set(db.map(e => e.designation).filter(Boolean))].sort();
  const departments = [...new Set(db.map(e => e.department).filter(Boolean))].sort();
  let farms = [...new Set(db.map(e => e.farmName).filter(Boolean))].sort();
  let farmCCs = [...new Set(db.map(e => e.farmCC).filter(Boolean))].sort();
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') farmCCs = [req.user.farmCC];
  res.render('joining', { designations, departments, farms, farmCCs, currentPath: '/joining', pageTitle: 'Joining Form' }); 
});

app.post('/joining/preview', ensureAuth, restrictTo('Admin', 'Farm Incharge', 'Farm Store Incharge'), (req, res) => {
  const { employeeName, designation, department, joiningDate, farmName, farmCC } = req.body;
  if (!employeeName || !designation || !department || !joiningDate || !farmName || !farmCC) return res.send("All fields are mandatory. <a href='/joining'>Go Back</a>");
  res.render('joining-preview', { data: { employeeName, designation, department, joiningDate, farmName, farmCC }, currentPath: '/joining', pageTitle: 'Joining Preview' });
});

app.post('/joining/save', ensureAuth, restrictTo('Admin', 'Farm Incharge', 'Farm Store Incharge'), (req, res) => {
  const { employeeName, designation, department, joiningDate, farmName, farmCC } = req.body;
  let db = loadDB();
  if ((req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') && String(farmCC) !== String(req.user.farmCC)) return res.status(403).send("Access Denied");
  const newEmp = { _id: 'emp_' + Date.now() + Math.floor(Math.random() * 1000), employeeId: '', employeeName, designation, department, joiningDate, farmCC, farmName, currentStatus: 'Active', workingDays: 0, carryForwardEL: 0, inactiveDate: '', absentFrom: '', absentTo: '', absentTillNow: false, transferHistory: [] };
  db.push(newEmp); saveDB(db); res.redirect('/active'); 
});

// ==========================================
// ৩. LEAVE ROUTES
// ==========================================
app.get('/leave/dashboard', ensureAuth, (req, res) => {
  const db = loadDB(); const leaveDb = loadLeaveDB();
  const year = req.query.year || new Date().getFullYear().toString();
  let activeEmployees = db.filter(e => e.currentStatus === 'Active').length;
  let totalApps = leaveDb.filter(a => new Date(a.fromDate).getFullYear() === parseInt(year)).length;
  let submittedApps = leaveDb.filter(a => new Date(a.fromDate).getFullYear() === parseInt(year) && a.status === 'Submitted').length;
  let totalDeducted = leaveDb.filter(a => new Date(a.fromDate).getFullYear() === parseInt(year) && a.status === 'Submitted').reduce((sum, a) => sum + a.totalDays, 0);
  res.render('leave/dashboard', { activeEmployees, totalApps, submittedApps, totalDeducted, year, currentPath: '/leave/dashboard', pageTitle: 'Leave Dashboard' });
});

app.get('/leave/history', ensureAuth, (req, res) => {
  const q = (req.query.q || '').toString().trim(); const db = loadDB(); const leaveDb = loadLeaveDB();
  const year = req.query.year || new Date().getFullYear().toString();
  let results = q ? db.filter(e => (e.employeeId && e.employeeId.toLowerCase().includes(q.toLowerCase())) || (e.employeeName && e.employeeName.toLowerCase().includes(q.toLowerCase()))) : [];
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') results = results.filter(e => String(e.farmCC) === String(req.user.farmCC));
  else if (req.user.role === 'General Employee') results = results.filter(e => e.employeeId === req.user.employeeId);
  let employee = results.length > 0 ? results[0] : null; let balances = {}; let history = [];
  if (employee) {
    const leaveTypes = ['Project Casual Leave', 'Casual Leave', 'Medical Leave', 'Marriage Leave', 'Paternity Leave', 'Hajj Leave', 'Omrah Leave', 'Bereavement Leave', 'Earn Leave'];
    leaveTypes.forEach(lt => { balances[lt] = getLeaveBalance(employee, year, lt); });
    history = leaveDb.filter(a => a.employeeId === employee.employeeId && new Date(a.fromDate).getFullYear() === parseInt(year));
    history.sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate));
  }
  res.render('leave/history', { query: q, employee, balances, history, year, currentPath: '/leave/history', pageTitle: 'Leave History' });
});

app.get('/leave/apply', ensureAuth, (req, res) => {
  const db = loadDB();
  const leaveTypes = ['Project Casual Leave', 'Casual Leave', 'Medical Leave', 'Marriage Leave', 'Paternity Leave', 'Hajj Leave', 'Omrah Leave', 'Bereavement Leave', 'Earn Leave'];
  let farms = [...new Set(db.map(e => e.farmName).filter(Boolean))].sort();
  let departments = [...new Set(db.map(e => e.department).filter(Boolean))].sort();
  res.render('leave/apply', { leaveTypes, farms, departments, employee: null, balances: {}, year: new Date().getFullYear(), currentPath: '/leave/apply', pageTitle: 'Apply for Leave' });
});

app.get('/api/employee/:id', ensureAuth, (req, res) => {
  const empId = req.params.id; const db = loadDB();
  let emp = db.find(e => e.employeeId === empId || e._id === empId);
  if (!emp) return res.json({ error: 'Employee not found' });
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') { if (String(emp.farmCC) !== String(req.user.farmCC)) return res.json({ error: 'Access Denied' }); }
  else if (req.user.role === 'General Employee') { if (emp.employeeId !== req.user.employeeId) return res.json({ error: 'Access Denied' }); }
  const year = new Date().getFullYear();
  const leaveTypes = ['Project Casual Leave', 'Casual Leave', 'Medical Leave', 'Marriage Leave', 'Paternity Leave', 'Hajj Leave', 'Omrah Leave', 'Bereavement Leave', 'Earn Leave'];
  let balances = {}; leaveTypes.forEach(lt => { balances[lt] = getLeaveBalance(emp, year, lt); });
  res.json({ employee: emp, balances, year });
});

app.post('/leave/apply/submit', ensureAuth, (req, res) => {
  const { employeeId, leaveType, fromDate, toDate, reason, assignedPerson, totalDays, balanceBefore } = req.body;
  let leaveDb = loadLeaveDB();
  leaveDb.push({ _id: 'APP-' + Date.now(), employeeId, employeeName: req.body.employeeName, leaveType, fromDate, toDate, totalDays: Number(totalDays), reason, assignedPerson, balanceBefore: Number(balanceBefore), balanceAfter: Number(balanceBefore) - Number(totalDays), status: 'Submitted', applicationDate: new Date().toISOString() });
  saveLeaveDB(leaveDb); res.redirect('/leave/applications');
});

app.get('/leave/applications', ensureAuth, (req, res) => {
  const leaveDb = loadLeaveDB(); let list = [...leaveDb].sort((a, b) => new Date(b.applicationDate) - new Date(a.applicationDate));
  const db = loadDB();
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') {
    list = list.filter(a => { const emp = db.find(e => e.employeeId === a.employeeId); return emp && String(emp.farmCC) === String(req.user.farmCC); });
  } else if (req.user.role === 'General Employee') list = list.filter(a => a.employeeId === req.user.employeeId);
  res.render('leave/applications', { list, currentPath: '/leave/applications', pageTitle: 'Leave Applications' });
});
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
app.listen(PORT, () => { console.log(`✅ Server running: http://localhost:${PORT}`); });