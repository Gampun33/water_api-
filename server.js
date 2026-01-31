require("dotenv").config(); 

// 👇 เพิ่ม 3 บรรทัดนี้เพื่อเช็คค่า (แล้วค่อยลบออกทีหลังนะ)
console.log("--- DEBUG ENV ---");
console.log("DB_HOST:", process.env.DB_HOST ? "✅ มีค่า" : "❌ ไม่มีค่า");
console.log("PORT:", process.env.PORT);
console.log("-----------------");

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");

const helmet = require("helmet");

const app = express();
app.use(helmet());
app.use(cors());
app.use(bodyParser.json());

// --- 1. ตั้งค่าเชื่อมต่อ MySQL (แก้ไขสำหรับ Aiven) ---
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT || 3306, // เผื่อไว้
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // 🟢 จุดที่ 1: ต้องเพิ่มตรงนี้ ไม่งั้น Aiven ไม่ยอมให้เข้า!
  ssl: {
      rejectUnauthorized: false
  }
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database Connection Failed:", err.message);
  } else {
    console.log("✅ Connected to MySQL Database (Aiven)!");
    connection.release();
  }
});

const logRequest = (method, path, body) => {
  console.log(
    `[${new Date().toLocaleTimeString()}] ${method} ${path}`,
    body ? JSON.stringify(body) : ""
  );
};

// --- 2. API Routes ---

app.get("/", (req, res) => {
  res.send("<h1>HydroMonitor API Server is Running! 🚀</h1>");
});

// --- 🔵 2.1 Login API ---
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  // 🔍 DEBUG
  console.log(`[LOGIN] User: ${username}`);

  const sql = "SELECT * FROM users WHERE username = ?";
  db.query(sql, [username], (err, results) => {
    if (err) {
      console.error("❌ SQL Error:", err.message);
      return res.status(500).json({ error: err.message });
    }

    if (results.length === 0) {
      return res.status(401).json({ message: "ไม่พบชื่อผู้ใช้นี้ในระบบ" });
    }

    const user = results[0];

    if (user.password === password) {
      console.log("✅ Login Success");
      res.json({
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.full_name || user.fullName,
        organization: user.organization,
      });
    } else {
      console.log("❌ Login Failed: Wrong Password");
      res.status(401).json({ message: "รหัสผ่านไม่ถูกต้อง" });
    }
  });
});

// --- 🔵 2.2 Water Reports APIs ---
app.get("/api/reports", (req, res) => {
  logRequest("GET", "/api/reports");

  const sql = `
    SELECT wr.*, (wr.current_volume / wr.capacity * 100) as calculated_percent
    FROM water_reports wr 
    ORDER BY wr.group_id ASC, wr.report_date DESC
  `;

  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    const formatted = results.map((row) => {
      const d = new Date(row.report_date);
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2, "0")}`;

      return {
        ...row,
        stationName: row.station_name,
        date: localDate,
        waterLevel: row.water_level,
        current: row.current_volume,
        percent: row.calculated_percent || 0,
        createdBy: row.created_by,
        tambon: row.tambon,
        amphoe: row.amphoe,
        province: row.province,
      };
    });
    res.json(formatted);
  });
});

app.post("/api/reports", (req, res) => {
  logRequest("POST", "/api/reports", req.body);

  const cleanData = {};
  Object.keys(req.body).forEach((key) => {
    const cleanKey = key.trim().replace(/[^\x20-\x7E]/g, "");
    cleanData[cleanKey] = req.body[key];
  });

  const {
    stationName, tambon, amphoe, province, date,
    waterLevel, capacity, inflow, outflow, createdBy, groupId,
  } = cleanData;
  const current_volume = parseFloat(waterLevel) || 0;

  const sql = `INSERT INTO water_reports 
    (station_name, tambon, amphoe, province, report_date, water_level, capacity, current_volume, inflow, outflow, status, created_by, group_id) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`;

  db.query(
    sql,
    [
      stationName, tambon || "-", amphoe || "-", province || "ลำปาง", date,
      waterLevel, capacity || 100, current_volume, inflow || 0, outflow || 0,
      createdBy, groupId || "group-large",
    ],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: result.insertId });
    }
  );
});

app.put("/api/reports/:id", (req, res) => {
  const { id } = req.params;
  const { stationName, tambon, amphoe, province, waterLevel, inflow, outflow, status } = req.body;
  
  logRequest("PUT", `/api/reports/${id}`, req.body);
  const current = parseFloat(waterLevel) || 0;

  const sql = `
    UPDATE water_reports 
    SET station_name=?, tambon=?, amphoe=?, province=?, water_level=?, current_volume=?, inflow=?, outflow=?, status=? 
    WHERE id=?
  `;

  db.query(
    sql,
    [stationName, tambon || "-", amphoe || "-", province || "ลำปาง", waterLevel, current, inflow || 0, outflow || 0, status, id],
    (err, result) => {
      if (err) {
        console.error("❌ UPDATE Error:", err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    }
  );
});

app.delete("/api/reports/:id", (req, res) => {
  db.query("DELETE FROM water_reports WHERE id = ?", [req.params.id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- 🔵 2.3 User Management APIs ---
app.get("/api/users", (req, res) => {
  db.query("SELECT id, username, role, full_name, organization FROM users", (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.post("/api/users", (req, res) => {
  const { username, password, role, fullName, organization } = req.body;
  const sql = "INSERT INTO users (username, password, role, full_name, organization) VALUES (?, ?, ?, ?, ?)";
  db.query(sql, [username, password, role, fullName, organization], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: result.insertId });
  });
});

app.put("/api/users/:id", (req, res) => {
  const { id } = req.params;
  const { username, role, fullName, organization, password } = req.body;
  let sql, params;
  if (password) {
    sql = "UPDATE users SET username=?, role=?, full_name=?, organization=?, password=? WHERE id=?";
    params = [username, role, fullName, organization, password, id];
  } else {
    sql = "UPDATE users SET username=?, role=?, full_name=?, organization=? WHERE id=?";
    params = [username, role, fullName, organization, id];
  }
  db.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete("/api/users/:id", (req, res) => {
  db.query("DELETE FROM users WHERE id = ?", [req.params.id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- 🔵 2.4 Rain Reports APIs ---
app.get("/api/rain-reports", (req, res) => {
  logRequest("GET", "/api/rain-reports");
  const sql = `SELECT * FROM rain_reports ORDER BY date DESC, created_at DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    const formatted = results.map((row) => {
      const d = new Date(row.date);
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return {
        ...row,
        stationName: row.stationName,
        date: localDate,
        rainAmount: parseFloat(row.rainAmount) || 0,
        createdBy: row.createdBy,
        status: row.status
      };
    });
    res.json(formatted);
  });
});

app.post("/api/rain-reports", (req, res) => {
  logRequest("POST", "/api/rain-reports", req.body);
  const { stationName, date, rainAmount, tambon, amphoe, province, groupId, createdBy } = req.body;
  const sql = `INSERT INTO rain_reports (stationName, date, rainAmount, tambon, amphoe, province, groupId, status, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`;
  db.query(sql, [stationName, date, rainAmount || 0, tambon || "-", amphoe || "-", province || "ลำปาง", groupId || "group-medium", createdBy], (err, result) => {
    if (err) {
      console.error("❌ INSERT Rain Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, id: result.insertId });
  });
});

app.put("/api/rain-reports/:id", (req, res) => {
  const { id } = req.params;
  const { rainAmount, status } = req.body;
  logRequest("PUT", `/api/rain-reports/${id}`, req.body);
  const sql = `UPDATE rain_reports SET rainAmount=?, status=? WHERE id=?`;
  db.query(sql, [rainAmount || 0, status, id], (err, result) => {
    if (err) {
      console.error("❌ UPDATE Rain Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

app.delete("/api/rain-reports/:id", (req, res) => {
  db.query("DELETE FROM rain_reports WHERE id = ?", [req.params.id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- 3. Start Server (แก้ไขสำหรับ Render) ---
// 🟢 จุดที่ 2: ใช้ process.env.PORT ถ้าไม่มีค่อยใช้ 3001
const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => {
  console.log(`✅ HydroMonitor Backend Running on port ${PORT}`);
});