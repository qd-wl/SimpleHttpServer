require('dotenv').config();
const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LOGS_DIR   = path.join(__dirname, 'logs');
const TRASH_DIR  = path.join(__dirname, 'trash');
const TRASH_META = path.join(TRASH_DIR, '_meta.json');

// 回收站保留天数，超过后自动彻底删除
const TRASH_RETENTION_DAYS = 15;

// 系统自动生成的隐藏文件，前端列表/目录树/搜索中统一隐藏
const IGNORED_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
function isIgnoredEntry(name) {
    return IGNORED_ENTRIES.has(name);
}

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

// 记录操作日志（req 为 null 时视为系统自动触发，例如定时清理任务）
function addLog(req, action, details = '') {
    let ip = 'system';
    let hostname = 'system';
    let userAgent = 'system';

    if (req) {
        // 清理IP地址，去掉IPv6前缀
        ip = req.ip || req.connection.remoteAddress || '';
        ip = ip.replace('::ffff:', '').replace('::1', 'localhost');
        hostname = req.hostname;
        userAgent = req.get('user-agent');
    }

    const log = {
        id: Date.now(),
        ip: ip,
        hostname: hostname,
        userAgent: userAgent,
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

// 清理回收站中超过保留期限的条目
let lastTrashPurgeAt = 0;
const TRASH_PURGE_MIN_INTERVAL = 60 * 1000; // 避免同步删除文件的开销在短时间内被频繁触发（如反复打开回收站）

function purgeExpiredTrash() {
    if (Date.now() - lastTrashPurgeAt < TRASH_PURGE_MIN_INTERVAL) {
        return;
    }
    lastTrashPurgeAt = Date.now();

    const meta = loadTrashMeta();
    const maxAge = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let changed = false;

    for (const [id, item] of Object.entries(meta)) {
        if (now - new Date(item.deletedAt).getTime() < maxAge) {
            continue;
        }

        const trashPath = path.join(TRASH_DIR, item.trashFileName);
        try {
            if (fs.existsSync(trashPath)) {
                if (item.isFolder) {
                    fs.rmSync(trashPath, { recursive: true });
                } else {
                    fs.unlinkSync(trashPath);
                }
            }
        } catch (error) {
            console.error('自动清理回收站失败:', error);
            continue;
        }

        delete meta[id];
        changed = true;
        addLog(null, '彻底删除', `${item.originalPath}（回收站保留超过 ${TRASH_RETENTION_DAYS} 天，自动清理）`);
    }

    if (changed) {
        saveTrashMeta(meta);
    }
}

function resolveUploadPath(relativePath = '') {
    const normalized = path.normalize(relativePath || '').replace(/^([/\\])+/, '');
    const fullPath = path.resolve(UPLOAD_DIR, normalized);

    if (fullPath !== UPLOAD_DIR && !fullPath.startsWith(UPLOAD_DIR + path.sep)) {
        throw new Error('无效路径');
    }

    const safeRelativePath = fullPath === UPLOAD_DIR
        ? ''
        : path.relative(UPLOAD_DIR, fullPath).split(path.sep).join('/');

    return { fullPath, relativePath: safeRelativePath };
}

function validateItemName(name) {
    if (!name || typeof name !== 'string') {
        throw new Error('名称不能为空');
    }

    if (name.includes('/') || name.includes('\\')) {
        throw new Error('名称不能包含路径分隔符');
    }

    return name.trim();
}

function getDisplayPath(relativePath = '') {
    return relativePath || '根目录';
}

function getDirectoryStats(dirPath) {
    const summary = {
        directFileCount: 0,
        directFolderCount: 0,
        totalFileCount: 0,
        totalFolderCount: 0,
        totalSize: 0
    };

    if (!fs.existsSync(dirPath)) {
        return summary;
    }

    const entries = fs.readdirSync(dirPath).filter(entry => !isIgnoredEntry(entry));

    entries.forEach(entry => {
        const entryPath = path.join(dirPath, entry);
        const stat = fs.statSync(entryPath);

        if (stat.isDirectory()) {
            summary.directFolderCount++;
            summary.totalFolderCount++;

            const childSummary = getDirectoryStats(entryPath);
            summary.totalFileCount += childSummary.totalFileCount;
            summary.totalFolderCount += childSummary.totalFolderCount;
            summary.totalSize += childSummary.totalSize;
        } else {
            summary.directFileCount++;
            summary.totalFileCount++;
            summary.totalSize += stat.size;
        }
    });

    return summary;
}

function searchItems(baseDir, keyword, relativeBasePath = '', results = []) {
    if (!fs.existsSync(baseDir)) {
        return results;
    }

    const entries = fs.readdirSync(baseDir).filter(entry => !isIgnoredEntry(entry));
    const needle = keyword.toLowerCase();

    entries.forEach(entry => {
        const fullPath = path.join(baseDir, entry);
        const stat = fs.statSync(fullPath);
        const relativePath = relativeBasePath ? `${relativeBasePath}/${entry}` : entry;

        if (entry.toLowerCase().includes(needle)) {
            results.push({
                name: entry,
                path: relativePath,
                parentPath: relativeBasePath,
                type: stat.isDirectory() ? 'folder' : 'file',
                size: stat.isDirectory() ? 0 : stat.size,
                modified: stat.mtime
            });
        }

        if (stat.isDirectory()) {
            searchItems(fullPath, keyword, relativePath, results);
        }
    });

    return results;
}


// 启动时加载历史日志
loadLogs();

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 启动时清理一次过期回收站条目，之后每小时定期检查
purgeExpiredTrash();
setInterval(purgeExpiredTrash, 60 * 60 * 1000);

// 配置文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            const { fullPath: targetDir } = resolveUploadPath(req.query.path || '');
            
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            cb(null, targetDir);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        try {
            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const mode = req.query.mode || 'replace';
            const { fullPath: targetDir } = resolveUploadPath(req.query.path || '');
            
            if (mode === 'keep') {
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
                cb(null, originalName);
            }
        } catch (error) {
            cb(error);
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
    
    const entries = fs.readdirSync(dirPath).filter(entry => !isIgnoredEntry(entry));

    entries.forEach(entry => {
        const fullPath = path.join(dirPath, entry);
        const stat = fs.statSync(fullPath);
        const itemPath = relativePath ? `${relativePath}/${entry}` : entry;

        if (stat.isDirectory()) {
            const children = buildTree(fullPath, itemPath);
            // 检查文件夹是否为空（没有子文件夹也没有文件）
            const allEntries = fs.readdirSync(fullPath).filter(e => !isIgnoredEntry(e));
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
    try {
        const { fullPath: targetDir } = resolveUploadPath(req.query.path || '');

        if (!fs.existsSync(targetDir)) {
            return res.json({ files: [], folders: [] });
        }

        const items = fs.readdirSync(targetDir).filter(item => !isIgnoredEntry(item));
        const files = [];
        const folders = [];

        items.forEach(item => {
            const itemPath = path.join(targetDir, item);
            const stat = fs.statSync(itemPath);

            if (stat.isDirectory()) {
                // 检查文件夹是否为空
                const folderEntries = fs.readdirSync(itemPath).filter(e => !isIgnoredEntry(e));
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
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: '参数缺失' });

    try {
        const safeName = validateItemName(name);
        const { fullPath: targetDir } = resolveUploadPath(req.query.path || '');
        const fullPath = path.join(targetDir, safeName);
        res.json({ exists: fs.existsSync(fullPath) });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 上传文件
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '没有上传文件' });
    }
    const targetPath = req.query.path || '';
    const fullPath = targetPath ? `${targetPath}/${req.file.filename}` : req.file.filename;
    addLog(req, '上传文件', fullPath);
    res.json({ 
        message: '文件上传成功',
        filename: req.file.filename 
    });
});

// 创建文件夹
app.post('/api/mkdir', (req, res) => {
    try {
        const { path: subPath, name } = req.body;
        const safeName = validateItemName(name);
        const { fullPath: parentDir, relativePath: parentRelativePath } = resolveUploadPath(subPath || '');
        const targetDir = path.join(parentDir, safeName);

        if (fs.existsSync(targetDir)) {
            return res.status(400).json({ error: '文件夹已存在' });
        }
        fs.mkdirSync(targetDir, { recursive: true });
        const fullPath = parentRelativePath ? `${parentRelativePath}/${safeName}` : safeName;
        addLog(req, '创建文件夹', fullPath);
        res.json({ message: '文件夹创建成功' });
    } catch (error) {
        const statusCode = error.message === '无效路径' || error.message.includes('名称') ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// 获取空间信息
app.get('/api/space', (req, res) => {
    try {
        const { fullPath: targetDir, relativePath } = resolveUploadPath(req.query.path || '');

        if (!fs.existsSync(targetDir)) {
            return res.status(404).json({ error: '目录不存在' });
        }

        const summary = getDirectoryStats(targetDir);
        const statfs = fs.statfsSync(targetDir);

        res.json({
            path: relativePath,
            directFileCount: summary.directFileCount,
            directFolderCount: summary.directFolderCount,
            totalFileCount: summary.totalFileCount,
            totalFolderCount: summary.totalFolderCount,
            totalSize: summary.totalSize,
            freeSpace: statfs.bavail * statfs.bsize,
            totalSpace: statfs.blocks * statfs.bsize,
            usedSpace: (statfs.blocks - statfs.bfree) * statfs.bsize,
            hostname: os.hostname()
        });
    } catch (error) {
        const statusCode = error.message === '无效路径' ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// 搜索文件和文件夹
app.get('/api/search', (req, res) => {
    const keyword = (req.query.keyword || '').trim();
    const scope = req.query.scope === 'all' ? 'all' : 'current';

    if (!keyword) {
        return res.status(400).json({ error: '请输入搜索关键词' });
    }

    try {
        const { fullPath: currentDir, relativePath: currentRelativePath } = resolveUploadPath(req.query.path || '');
        const baseDir = scope === 'all' ? UPLOAD_DIR : currentDir;
        const baseRelativePath = scope === 'all' ? '' : currentRelativePath;
        const results = searchItems(baseDir, keyword, baseRelativePath)
            .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));

        res.json({
            keyword,
            scope,
            basePath: baseRelativePath,
            results
        });
    } catch (error) {
        const statusCode = error.message === '无效路径' ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// 下载文件
app.get('/api/download', (req, res) => {
    try {
        const { fullPath, relativePath } = resolveUploadPath(req.query.path || '');

        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const pathDisplay = getDisplayPath(relativePath);
        addLog(req, '下载文件', pathDisplay);
        res.download(fullPath);
    } catch (error) {
        const statusCode = error.message === '无效路径' ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// 删除文件或文件夹（移入回收站）
app.delete('/api/delete', (req, res) => {
    const itemPath = req.query.path;
    if (!itemPath) {
        return res.status(400).json({ error: '无效路径' });
    }

    try {
        const { fullPath, relativePath } = resolveUploadPath(itemPath);

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
            originalPath: relativePath,
            originalName,
            deletedAt: new Date().toISOString(),
            isFolder,
            size: isFolder ? 0 : stat.size
        };
        saveTrashMeta(meta);

        const pathDisplay = getDisplayPath(relativePath);
        addLog(req, isFolder ? '删除文件夹' : '删除文件', `${pathDisplay} → 回收站`);
        res.json({ message: '已移入回收站' });
    } catch (error) {
        const statusCode = error.message === '无效路径' ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// ── 回收站 API ────────────────────────────────────────────────

// 获取回收站列表
app.get('/api/trash', (req, res) => {
    purgeExpiredTrash();
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

    try {
        const safeName = validateItemName(newName);
        const { fullPath: oldFullPath, relativePath: oldRelativePath } = resolveUploadPath(oldPath);

        const parentDir = path.dirname(oldRelativePath);
        const newPath = parentDir === '.' ? safeName : path.join(parentDir, safeName);
        const { fullPath: newFullPath, relativePath: newRelativePath } = resolveUploadPath(newPath);

        if (!fs.existsSync(oldFullPath)) {
            return res.status(404).json({ error: '文件或文件夹不存在' });
        }

        if (fs.existsSync(newFullPath)) {
            return res.status(400).json({ error: '目标名称已存在' });
        }

        const isDirectory = fs.statSync(oldFullPath).isDirectory();
        fs.renameSync(oldFullPath, newFullPath);

        const oldPathDisplay = getDisplayPath(oldRelativePath);
        const newPathDisplay = getDisplayPath(newRelativePath);
        addLog(req, isDirectory ? '重命名文件夹' : '重命名文件', `${oldPathDisplay} → ${newPathDisplay}`);
        
        res.json({ message: '重命名成功', newPath: newRelativePath });
    } catch (error) {
        const statusCode = error.message === '无效路径' || error.message.includes('名称') ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n服务器已启动！`);
    console.log(`本地访问: http://localhost:${PORT}`);
    console.log(`文件存储目录: ${UPLOAD_DIR}\n`);
});
