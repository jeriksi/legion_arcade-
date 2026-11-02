const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Сервер Legion Arcade успешно работает! 🐾');
});

app.listen(PORT, () => console.log(`Слушаем порт ${PORT}`));
