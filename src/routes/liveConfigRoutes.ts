import { Router } from 'express';
import { LiveConfigService } from '../services/LiveConfigService.js';

const router = Router();

router.get('/', async (req, res) => {
    try {
        const configs = await LiveConfigService.getAllConfigs();
        res.json(configs);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const config = await LiveConfigService.createConfig(req.body);
        res.json(config);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const config = await LiveConfigService.updateConfig(req.params.id, req.body);
        res.json(config);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await LiveConfigService.deleteConfig(req.params.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:id/toggle', async (req, res) => {
    try {
        const config = await LiveConfigService.toggleEnabled(req.params.id);
        res.json(config);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
