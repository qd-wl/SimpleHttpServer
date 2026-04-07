require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LOGS_DIR   = path.join(__dirname, 'logs');
const TRASH_DIR  = path.join(__dirname, 'trash');
const TRASH_META = path.join(TRASH_DIR, '_meta.json');

// 确保回收站目录存在
if (!fs.existsSync(TRASH_DIR)) {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
}

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

// 回收站元数据读写
function loadTrashMeta() {
    try {
        if (fs.existsSync(TRASH_META)) {
            return JSON.parse(fs.readFileSync(TRASH_META, 'utf8'));
        }
    } catch (e) {}
    return {};
}

function saveTrashMeta(meta) {
    fs.writeFileSync(TRASH_META, JSON.stringify(meta, null, 2), 'utf8');
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
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const mode = req.query.mode || 'replace';
        
        if (mode === 'keep') {
            const subPath = req.query.path || '';
            const targetDir = path.join(UPLOAD_DIR, subPath);
            const ext = path.extname(originalName);
            const base = path.basename(originalName, ext);
            let counter = 2;
            let newName = originalName;
            while (fs.existsSync(path.join(targetDir, newName))) {
                newName = `${base} ${counter}${ext}`;
                counter++;
            }
            cb(null, newName);
        } else {
            // replace: 直接覆盖
            cb(null, originalName);
        }
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

// 检查文件是否存在
app.get('/api/check-file', (req, res) => {
    const subPath = req.query.path || '';
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: '参数缺失' });
    const fullPath = path.join(UPLOAD_DIR, subPath, name);
    res.json({ exists: fs.existsSync(fullPath) });
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

// 删除文件或文件夹（移入回收站）
app.delete('/api/delete', (req, res) => {
    const itemPath = req.query.path;
    if (!itemPath || itemPath.includes('..')) {
        return res.status(400).json({ error: '无效路径' });
    }
    const fullPath = path.join(UPLOAD_DIR, itemPath);
    if (!fullPath.startsWith(UPLOAD_DIR + path.sep)) {
        return res.status(400).json({ error: '无效路径' });
    }

    try {
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const stat = fs.statSync(fullPath);
        const isFolder = stat.isDirectory();
        const originalName = path.basename(itemPath);
        const trashId = Date.now().toString();
        const trashFileName = `${trashId}_${originalName}`;
        const trashPath = path.join(TRASH_DIR, trashFileName);

        // 移入回收站
        fs.renameSync(fullPath, trashPath);

        // 更新元数据
        const meta = loadTrashMeta();
        meta[trashId] = {
            trashFileName,
            originalPath: itemPath,
            originalName,
            deletedAt: new Date().toISOString(),
            isFolder,
            size: isFolder ? 0 : stat.size
        };
        saveTrashMeta(meta);

        const pathDisplay = `根目录 / ${itemPath}`;
        addLog(req, isFolder ? '删除文件夹' : '删除文件', `${pathDisplay} → 回收站`);
        res.json({ message: '已移入回收站' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── 回收站 API ────────────────────────────────────────────────

// 获取回收站列表
app.get('/api/trash', (req, res) => {
    const meta = loadTrashMeta();
    const items = Object.entries(meta).map(([id, info]) => ({ id, ...info }))
        .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
    res.json(items);
});

// 还原
app.post('/api/trash/restore', (req, res) => {
    const { id } = req.body;
    const meta = loadTrashMeta();
    if (!meta[id]) return res.status(404).json({ error: '找不到该条目' });

    const item = meta[id];
    const trashPath  = path.join(TRASH_DIR, item.trashFileName);
    const restorePath = path.join(UPLOAD_DIR, item.originalPath);

    if (!fs.existsSync(trashPath)) {
        delete meta[id]; saveTrashMeta(meta);
        return res.status(404).json({ error: '回收站文件已丢失' });
    }

    // 确保父目录存在
    fs.mkdirSync(path.dirname(restorePath), { recursive: true });

    // 如果目标已存在，自动重命名
    let finalPath = restorePath;
    if (fs.existsSync(restorePath)) {
        const ext  = path.extname(item.originalName);
        const base = path.basename(item.originalName, ext);
        let n = 2;
        while (fs.existsSync(finalPath)) {
            finalPath = path.join(path.dirname(restorePath), `${base} ${n}${ext}`);
            n++;
        }
    }

    fs.renameSync(trashPath, finalPath);
    delete meta[id];
    saveTrashMeta(meta);
    addLog(req, '还原文件', item.originalPath);
    res.json({ message: '还原成功' });
});

// 从回收站彻底删除
app.delete('/api/trash/delete', (req, res) => {
    const id = req.query.id;
    const meta = loadTrashMeta();
    if (!meta[id]) return res.status(404).json({ error: '找不到该条目' });

    const item = meta[id];
    const trashPath = path.join(TRASH_DIR, item.trashFileName);
    try {
        if (fs.existsSync(trashPath)) {
            if (item.isFolder) {
                fs.rmSync(trashPath, { recursive: true });
            } else {
                fs.unlinkSync(trashPath);
            }
        }
        delete meta[id];
        saveTrashMeta(meta);
        addLog(req, '彻底删除', item.originalPath);
        res.json({ message: '已彻底删除' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 清空回收站
app.delete('/api/trash/clear', (req, res) => {
    const meta = loadTrashMeta();
    try {
        for (const [, item] of Object.entries(meta)) {
            const trashPath = path.join(TRASH_DIR, item.trashFileName);
            if (fs.existsSync(trashPath)) {
                if (item.isFolder) {
                    fs.rmSync(trashPath, { recursive: true });
                } else {
                    fs.unlinkSync(trashPath);
                }
            }
        }
        saveTrashMeta({});
        addLog(req, '清空回收站', '');
        res.json({ message: '回收站已清空' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 重命名文件夹
app.put('/api/rename', (req, res) => {
    const { oldPath, newName } = req.body;
    
    if (!oldPath || !newName) {
        return res.status(400).json({ error: '参数不完整' });
    }
    
    // 验证新名称不包含路径分隔符
    if (newName.includes('/') || newName.includes('\\')) {
        return res.status(400).json({ error: '名称不能包含路径分隔符' });
    }
    
    const oldFullPath = path.join(UPLOAD_DIR, oldPath);
    
    // 计算新路径：保持相同的父目录
    const parentDir = path.dirname(oldPath);
    const newPath = parentDir === '.' ? newName : path.join(parentDir, newName);
    const newFullPath = path.join(UPLOAD_DIR, newPath);
    
    try {
        if (!fs.existsSync(oldFullPath)) {
            return res.status(404).json({ error: '文件夹不存在' });
        }
        
        if (fs.existsSync(newFullPath)) {
            return res.status(400).json({ error: '目标名称已存在' });
        }
        
        fs.renameSync(oldFullPath, newFullPath);
        
        const oldPathDisplay = oldPath ? `根目录 / ${oldPath}` : '根目录';
        const newPathDisplay = newPath ? `根目录 / ${newPath}` : '根目录';
        addLog(req, '重命名文件夹', `${oldPathDisplay} → ${newPathDisplay}`);
        
        res.json({ message: '重命名成功', newPath });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n服务器已启动！`);
    console.log(`本地访问: http://localhost:${PORT}`);
    console.log(`文件存储目录: ${UPLOAD_DIR}\n`);
});
