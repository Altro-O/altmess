import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { username, email, password } = await request.json();

    // Валидация входных данных
    if (!username || !email || !password) {
      return NextResponse.json(
        { error: 'Все поля обязательны для заполнения' },
        { status: 400 }
      );
    }

    // Хеширование пароля
    const hashedPassword = require('crypto')
      .createHash('sha256')
      .update(password)
      .digest('hex');

    // Здесь должна быть логика сохранения пользователя в базе данных
    // Пока просто возвращаем успешный ответ
    return NextResponse.json({
      success: true,
      message: 'Пользователь успешно зарегистрирован',
      user: {
        id: Date.now().toString(), // В реальном приложении используйте UUID
        username,
        email,
      }
    });

  } catch (error) {
    console.error('Ошибка регистрации:', error);
    return NextResponse.json(
      { error: 'Внутренняя ошибка сервера' },
      { status: 500 }
    );
  }
}