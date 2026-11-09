<div align="center">
  <img src="../../src-tauri/icons/128x128.png" width="112" alt="Kiri">
  <h1>Kiri</h1>
  <p>Снимки экрана, распознавание текста и запись экрана. Ваши снимки остаются локальными.</p>
  <p>Для macOS, Windows и Linux.</p>
  <p><a href="https://kiri.yuxino.cn">Сайт</a> · <a href="https://github.com/yuxino/kiri/releases/latest">Скачать последнюю версию</a></p>
  <p><a href="../../README.md">简体中文</a> · <a href="en.md">English</a> · <a href="zh-TW.md">繁體中文</a> · <a href="ja.md">日本語</a> · <a href="de.md">Deutsch</a> · <a href="ko.md">한국어</a> · <a href="fr.md">Français</a> · <strong>Русский</strong></p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/github/v/release/yuxino/kiri?style=flat&amp;logo=github&amp;logoColor=white" alt="Release"></a>
    <a href="https://github.com/yuxino/kiri/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/yuxino/kiri/build.yml?style=flat&amp;logo=githubactions&amp;logoColor=white&amp;branch=main&amp;event=push&amp;label=CI" alt="CI"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/yuxino/kiri?style=flat&amp;logo=opensourceinitiative&amp;logoColor=white" alt="MIT"></a>
  </p>
</div>

![Kiri](../assets/readme-preview.png)

## Возможности

- Захватывайте окно или область, добавляйте текст, стрелки или мозаику и закрепляйте снимки как плавающие образцы. После сохранения можно увеличить и продолжить редактирование.
- Прокручивайте вверх или вниз, чтобы собрать длинный снимок; возврат к уже захваченному содержимому не добавляет его дважды (macOS, Windows, Linux X11).
- Извлекайте текст локальным OCR и распознавайте QR-коды.
- Записывайте MP4 с системным звуком и микрофоном или сохраняйте GIF без звука.
- Обрезайте и меняйте порядок клипов одного видео, затем экспортируйте новый MP4.
- Ищите, помечайте, добавляйте в избранное и экспортируйте локальные снимки; корзина хранит случайные удаления.
- Задавайте, отключайте и восстанавливайте глобальные сочетания клавиш в настройках; элементы управления записью активны только во время записи ([Wayland использует настройки рабочего стола](../linux.md)).
- Включайте запуск при входе в «Настройки → Общие» при необходимости. По умолчанию выключено и запускает Kiri в фоне, не открывая библиотеку.

## Начало работы

1. Нажмите `⇧⌘A` в macOS или `Shift+Ctrl+A` в Windows / Linux X11, чтобы открыть захват.
2. Выберите «Снимок», «Запись» или «OCR», затем нажмите на окно или выделите область.
3. Для снимка нажмите `Enter`, чтобы завершить, или `Esc`, чтобы отменить. Готовые снимки попадают в буфер обмена и библиотеку.

[Установка и справка](../usage.ru.md) · [Редактирование видео](../video-editing.ru.md) · [Linux](../linux.md) · [Сообщить о проблеме](https://github.com/yuxino/kiri/issues)

## Благодарности

Спасибо всем, кто пишет код, сообщает о проблемах, пробует Kiri или делится им.

Особая благодарность [@kerwin2046](https://github.com/kerwin2046) за [начальную поддержку Linux](https://github.com/yuxino/kiri/pull/20) и [@LLLin000](https://github.com/LLLin000) за [исправление выравнивания захвата при масштабировании текста в Windows](https://github.com/yuxino/kiri/pull/61).

Спасибо также сообществам [V2EX](https://www.v2ex.com/), [LINUX DO](https://linux.do/), [Appinn](https://www.appinn.com/), [NodeLoc](https://www.nodeloc.com/) за отзывы и публикации.

[Все участники](https://github.com/yuxino/kiri/graphs/contributors) · [Участие в разработке](../../CONTRIBUTING.md) · [Конфиденциальность](../privacy/en.md) · [MIT](../../LICENSE) © 2026 yuxino
