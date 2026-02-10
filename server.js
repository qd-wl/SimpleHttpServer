const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LOGS_DIR = path.join(__dirname, 'logs');

// 确保日志目录存在
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// 操作日志数组（内存缓存）
let operationLogs = [];
const MAX_LOGS = 1000; // 最多保存1000条

// 获取今天的日志文件路径
function getTodayLogFile() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOGS_DIR, `${today}.log`);
}

// 从所有日志文件加载日志
function loadLogs() {
    try {
        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.log'))
            .sort()
            .reverse(); // 最新的在前面
        
        operationLogs = [];
        
        for (const file of logFiles) {
            if (operationLogs.length >= MAX_LOGS) break;
            
            const filePath = path.join(LOGS_DIR, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.trim().split('\n').filter(line => line);
            
            for (const line of lines) {
                if (operationLogs.length >= MAX_LOGS) break;
                try {
                    const log = JSON.parse(line);
                    operationLogs.push(log);
                } catch (e) {
                    console.error('解析日志行失败:', e);
                }
            }
        }
        
        console.log(`已加载 ${operationLogs.length} 条历史日志`);
    } catch (error) {
        console.error('加载日志失败:', error);
    }
}

// 记录操作日志
function addLog(req, action, details = '') {
    // 清理IP地址，去掉IPv6前缀
    let ip = req.ip || req.connection.remoteAddress || '';
    ip = ip.replace('::ffff:', '').replace('::1', 'localhost');
    
    const log = {
        id: Date.now(),
        ip: ip,
        hostname: req.hostname,
        userAgent: req.get('user-agent'),
        action: action,
        details: details,
        timestamp: new Date().toISOString()
    };
    
    // 添加到内存
    operationLogs.unshift(log);
    if (operationLogs.length > MAX_LOGS) {
        operationLogs.pop();
    }
    
    // 写入文件
    try {
        const logFile = getTodayLogFile();
        fs.appendFileSync(logFile, JSON.stringify(log) + '\n', 'utf8');
    } catch (error) {
        console.error('写入日志文件失败:', error);
    }
    
    console.log(`[${log.timestamp}] ${log.ip} - ${action} ${details}`);
}

// 启动时加载历史日志
loadLogs();

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 配置文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const subPath = req.query.path || '';
        const targetDir = path.join(UPLOAD_DIR, subPath);
        
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        cb(null, targetDir);
    },
    filename: (req, file, cb) => {
        // 使用原始文件名
        cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
});

const upload = multer({ storage });

// 静态文件服务
app.use(express.static('public'));
app.use(express.json());

// 获取操作日志
app.get('/api/logs', (req, res) => {
    res.json(operationLogs);
});

// 获取目录树
app.get('/api/tree', (req, res) => {
    try {
        const tree = buildTree(UPLOAD_DIR, '');
        res.json(tree);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 递归构建目录树
function buildTree(dirPath, relativePath) {
    const items = [];
    
    if (!fs.existsSync(dirPath)) {
        return items;
    }
    
    const entries = fs.readdirSync(dirPath);
    
    entries.forEach(entry => {
        const fullPath = path.join(dirPath, entry);
        const stat = fs.statSync(fullPath);
        const itemPath = relativePath ? `${relativePath}/${entry}` : entry;
        
        if (stat.isDirectory()) {
            const children = buildTree(fullPath, itemPath);
            // 检查文件夹是否为空（没有子文件夹也没有文件）
            const allEntries = fs.readdirSync(fullPath);
            const isEmpty = allEntries.length === 0;
            
            items.push({
                name: entry,
                path: itemPath,
                type: 'folder',
                isEmpty: isEmpty,
                children: children
            });
        }
    });
    
    return items;
}

// 获取文件列表
app.get('/api/files', (req, res) => {
    const subPath = req.query.path || '';
    const targetDir = path.join(UPLOAD_DIR, subPath);
    
    if (!fs.existsSync(targetDir)) {
        return res.json({ files: [], folders: [] });
    }
    
    try {
        const items = fs.readdirSync(targetDir);
        const files = [];
        const folders = [];
        
        items.forEach(item => {
            const itemPath = path.join(targetDir, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory()) {
                // 检查文件夹是否为空
                const folderEntries = fs.readdirSync(itemPath);
                const isEmpty = folderEntries.length === 0;
                
                folders.push({
                    name: item,
                    type: 'folder',
                    isEmpty: isEmpty
                });
            } else {
                files.push({
                    name: item,
                    size: stat.size,
                    type: 'file',
                    modified: stat.mtime
                });
            }
        });
        
        res.json({ files, folders });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 上传文件
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '没有上传文件' });
    }
    const targetPath = req.query.path || '';
    const fullPath = targetPath ? `根目录 / ${targetPath} / ${req.file.filename}` : `根目录 / ${req.file.filename}`;
    addLog(req, '上传文件', fullPath);
    res.json({ 
        message: '文件上传成功',
        filename: req.file.filename 
    });
});

// 创建文件夹
app.post('/api/mkdir', (req, res) => {
    const { path: subPath, name } = req.body;
    const targetDir = path.join(UPLOAD_DIR, subPath || '', name);
    
    try {
        if (fs.existsSync(targetDir)) {
            return res.status(400).json({ error: '文件夹已存在' });
        }
        fs.mkdirSync(targetDir, { recursive: true });
        const fullPath = subPath ? `根目录 / ${subPath} / ${name}` : `根目录 / ${name}`;
        addLog(req, '创建文件夹', fullPath);
        res.json({ message: '文件夹创建成功' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 下载文件
app.get('/api/download', (req, res) => {
    const filePath = req.query.path;
    const fullPath = path.join(UPLOAD_DIR, filePath);
    
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: '文件不存在' });
    }
    
    const pathDisplay = filePath ? `根目录 / ${filePath}` : '根目录';
    addLog(req, '下载文件', pathDisplay);
    res.download(fullPath);
});

// 删除文件或文件夹
app.delete('/api/delete', (req, res) => {
    const itemPath = req.query.path;
    const fullPath = path.join(UPLOAD_DIR, itemPath);
    
    try {
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: '文件不存在' });
        }
        
        const pathDisplay = itemPath ? `根目录 / ${itemPath}` : '根目录';
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true });
            addLog(req, '删除文件夹', pathDisplay);
        } else {
            fs.unlinkSync(fullPath);
            addLog(req, '删除文件', pathDisplay);
        }
        
        res.json({ message: '删除成功' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n服务器已启动！`);
    console.log(`本地访问: http://localhost:${PORT}`);
    console.log(`文件存储目录: ${UPLOAD_DIR}\n`);
});
