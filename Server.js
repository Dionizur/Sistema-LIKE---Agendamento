const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());

// Serve os arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// 🔗 CONEXÃO COM O BANCO DE DADOS EXTERNO
// Subclua <PASSWORD> pela sua senha real do MongoDB Atlas
const MONGO_URI = 'SUA_STRING_DE_CONEXAO_DO_MONGODB_AQUI'; 

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Conectado com sucesso ao MongoDB Atlas!'))
    .catch(err => console.error('❌ Erro ao conectar ao banco:', err));

// 📝 SCHEMA (Modelo do Banco de Dados)
const AppointmentSchema = new mongoose.Schema({
    title: String,
    date: String,
    time: String,
    duration: String,
    notes: String
});
const Appointment = mongoose.model('Appointment', AppointmentSchema);

// 🌐 ROTAS DA API

// Rota de Login simples
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Usuário ou senha inválidos' });
    }
});

// Buscar todos os agendamentos
app.get('/api/appointments', async (req, res) => {
    try {
        const list = await Appointment.find().sort({ date: 1, time: 1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Criar novo agendamento (com suporte a recorrência)
app.post('/api/appointments', async (req, res) => {
    const { title, date, time, duration, recurrenceWeeks, notes } = req.body;
    let baseDate = new Date(date + "T00:00:00");
    let savedAppointments = [];

    try {
        for (let i = 0; i <= parseInt(recurrenceWeeks); i++) {
            let appointmentDate = new Date(baseDate);
            appointmentDate.setDate(appointmentDate.getDate() + (i * 7));

            const newApp = new Appointment({
                title,
                date: appointmentDate.toISOString().split('T')[0],
                time,
                duration,
                notes
            });
            await newApp.save();
            savedAppointments.push(newApp);
        }
        res.status(201).json({ success: true, data: savedAppointments });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Deletar agendamento
app.delete('/api/appointments/:id', async (req, res) => {
    try {
        await Appointment.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Inicia o servidor local
const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}`));