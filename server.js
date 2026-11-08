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

app.get('/leave/policy', ensureAuth, (req, res) => { 
  res.render('leave/policy', { currentPath: '/leave/policy', pageTitle: 'Leave Policy' }); 
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

// ==========================================
// ৪. LEAVE PDF DOWNLOAD (NOTUN ADD KORA)
// ==========================================
app.get('/leave/download/:id', ensureAuth, (req, res) => {
  const leaveDb = loadLeaveDB(); const appLeave = leaveDb.find(a => a._id === req.params.id);
  if (!appLeave) return res.send("Application not found");

  const db = loadDB();
  const emp = db.find(e => e.employeeId === appLeave.employeeId);
  
  if (req.user.role === 'Farm Incharge' || req.user.role === 'Farm Store Incharge') {
    if (!emp || String(emp.farmCC) !== String(req.user.farmCC)) return res.status(403).send("Access Denied");
  } else if (req.user.role === 'General Employee') {
    if (appLeave.employeeId !== req.user.employeeId) return res.status(403).send("Access Denied");
  }

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Leave_Application_${appLeave._id}.pdf"`);
  doc.pipe(res);

  const logoPath = path.join(__dirname, 'public', 'logo.png');
  if (fs.existsSync(logoPath)) { doc.image(logoPath, 237.5, 40, { width: 120, align: 'center' }); doc.moveDown(5); }

  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a5276').text('NOURISH POULTRY AND HATCHERY LIMITED', { align: 'center' });
  doc.fontSize(10).font('Helvetica').fillColor('#000000').text('EMPLOYEE LEAVE APPLICATION FORM', { align: 'center' });
  doc.moveDown(1.5);

  doc.text(`Application Date: ${new Date(appLeave.applicationDate).toLocaleDateString('en-GB')}`, 40, doc.y, { align: 'left' });
  doc.text(`Farm / Location: ${emp ? emp.farmName : 'N/A'}`, { align: 'right' });
  doc.moveDown(1.5);

  doc.font('Helvetica-Bold').fontSize(11).text('1. EMPLOYEE INFORMATION');
  doc.moveDown(0.5);
  
  const empStartY = doc.y;
  const c1_w = 257;
  const rowH = 25;
  const tableStartX = 40;

  doc.rect(tableStartX, empStartY, c1_w, rowH).stroke();
  doc.rect(tableStartX + c1_w, empStartY, c1_w, rowH).stroke();
  doc.font('Helvetica-Bold').text('Employee ID', tableStartX + 5, empStartY + 8);
  doc.font('Helvetica').text(appLeave.employeeId || 'Pending', tableStartX + 100, empStartY + 8);
  doc.font('Helvetica-Bold').text('Employee Name', tableStartX + c1_w + 5, empStartY + 8);
  doc.font('Helvetica').text(appLeave.employeeName, tableStartX + c1_w + 100, empStartY + 8);

  doc.rect(tableStartX, empStartY + rowH, c1_w, rowH).stroke();
  doc.rect(tableStartX + c1_w, empStartY + rowH, c1_w, rowH).stroke();
  doc.font('Helvetica-Bold').text('Designation', tableStartX + 5, empStartY + rowH + 8);
  doc.font('Helvetica').text(emp ? emp.designation : 'N/A', tableStartX + 100, empStartY + rowH + 8);
  doc.font('Helvetica-Bold').text('Department', tableStartX + c1_w + 5, empStartY + rowH + 8);
  doc.font('Helvetica').text(emp ? emp.department : 'N/A', tableStartX + c1_w + 100, empStartY + rowH + 8);

  doc.y = empStartY + rowH * 2 + 15;
  doc.font('Helvetica-Bold').fontSize(11).text('2. LEAVE INFORMATION');
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').text('Leave Type (Tick ✓ One):');
  doc.moveDown(0.5);
  
  const leaveTypesList = ['Project Casual Leave', 'Casual Leave', 'Medical Leave', 'Marriage Leave', 'Paternity Leave', 'Hajj Leave', 'Omrah Leave', 'Bereavement Leave', 'Earn Leave'];
  let chkX = 40; let chkY = doc.y;
  leaveTypesList.forEach((type, index) => {
    if (index > 0 && index % 3 === 0) { chkX = 40; chkY += 20; }
    const isChecked = appLeave.leaveType === type;
    doc.font(isChecked ? 'Helvetica-Bold' : 'Helvetica').text(`${isChecked ? '☑' : '☐'} ${type}`, chkX, chkY);
    chkX += 180;
  });
  
  doc.y = chkY + 25;
  const dateTableY = doc.y;
  const w1 = 150, w2 = 180, w3 = 185;
  const c2X = tableStartX + w1;
  const c3X = c2X + w2;

  doc.rect(tableStartX, dateTableY, w1, rowH).stroke();
  doc.rect(c2X, dateTableY, w2, rowH).stroke();
  doc.rect(c3X, dateTableY, w3, rowH).stroke();
  doc.font('Helvetica-Bold').text('Leave From', tableStartX + 5, dateTableY + 8);
  doc.text('Leave To', c2X + 5, dateTableY + 8);
  doc.text('Total Leave Days', c3X + 5, dateTableY + 8);

  doc.rect(tableStartX, dateTableY + rowH, w1, rowH).stroke();
  doc.rect(c2X, dateTableY + rowH, w2, rowH).stroke();
  doc.rect(c3X, dateTableY + rowH, w3, rowH).stroke();
  doc.font('Helvetica').text(new Date(appLeave.fromDate).toLocaleDateString('en-GB'), tableStartX + 5, dateTableY + rowH + 8);
  doc.text(new Date(appLeave.toDate).toLocaleDateString('en-GB'), c2X + 5, dateTableY + rowH + 8);
  doc.text(appLeave.totalDays.toString(), c3X + 5, dateTableY + rowH + 8);

  doc.y = dateTableY + rowH * 2 + 15;
  doc.font('Helvetica-Bold').fontSize(11).text('3. DETAILS / REASON FOR LEAVE');
  doc.moveDown(0.5);
  const reasonY = doc.y;
  doc.rect(tableStartX, reasonY, 515, 40).stroke();
  doc.font('Helvetica').text(appLeave.reason || 'N/A', tableStartX + 5, reasonY + 8, { width: 505 });
  doc.y = reasonY + 50;

  doc.font('Helvetica-Bold').fontSize(11).text('4. REMAINING LEAVE BALANCE');
  doc.moveDown(0.5);
  const balTableY = doc.y;
  doc.rect(tableStartX, balTableY, 300, rowH).fillAndStroke('#f0f0f0', '#000');
  doc.rect(tableStartX + 300, balTableY, 215, rowH).fillAndStroke('#f0f0f0', '#000');
  doc.fillColor('#000000').font('Helvetica-Bold').text('Particulars', tableStartX + 5, balTableY + 8);
  doc.text('Days', tableStartX + 305, balTableY + 8);

  const balRows = [
    ['Existing Leave Balance Before Application', appLeave.balanceBefore],
    ['Newly Requested Leave', appLeave.totalDays],
    ['Remaining Balance After Submission', appLeave.balanceAfter]
  ];

  let bY = balTableY + rowH;
  balRows.forEach(row => {
    doc.rect(tableStartX, bY, 300, rowH).stroke();
    doc.rect(tableStartX + 300, bY, 215, rowH).stroke();
    doc.font('Helvetica').text(row[0], tableStartX + 5, bY + 8);
    doc.text(row[1].toString(), tableStartX + 305, bY + 8);
    bY += rowH;
  });

  doc.y = bY + 15;
  doc.font('Helvetica-Bold').fontSize(11).text('5. SIGNATURE & APPROVAL');
  doc.moveDown(0.5);
  
  const sigY = doc.y;
  const sW = 171;
  doc.rect(tableStartX, sigY, sW, 60).stroke();
  doc.rect(tableStartX + sW, sigY, sW, 60).stroke();
  doc.rect(tableStartX + sW * 2, sigY, sW, 60).stroke();
  
  doc.font('Helvetica-Bold').text('Employee Signature', tableStartX + 5, sigY + 5);
  doc.font('Helvetica').text(`Name: ${appLeave.employeeName}`, tableStartX + 5, sigY + 25);
  doc.font('Helvetica-Bold').text('Recommended By', tableStartX + sW + 5, sigY + 5);
  doc.font('Helvetica').text('Name:', tableStartX + sW + 5, sigY + 25);
  doc.text('Designation:', tableStartX + sW + 5, sigY + 35);
  doc.text('Signature:', tableStartX + sW + 5, sigY + 45);
  doc.font('Helvetica-Bold').text('Approved By', tableStartX + sW * 2 + 5, sigY + 5);
  doc.font('Helvetica').text('Name:', tableStartX + sW * 2 + 5, sigY + 25);
  doc.text('Designation:', tableStartX + sW * 2 + 5, sigY + 35);
  doc.text('Signature:', tableStartX + sW * 2 + 5, sigY + 45);

  doc.end();
});

// ==========================================
// SERVER START
// ==========================================
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
app.listen(PORT, () => { console.log(`✅ Server running: http://localhost:${PORT}`); });