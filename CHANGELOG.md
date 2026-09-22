# Changelog

## Unreleased

- Retarget acceptance GPU docs/hints to **RTX 2060** (~6 GB VRAM; Super often 8 GB). Prior 3060 Ti 16 GB references removed from sizing/ACCEPTANCE. No LICENSE/UI changes.
- Compose-профиль `gpu-probe`: образ с pinned CUDA 12.4 / PyTorch 2.6.0+cu124 / GigaAM `0a3f103`, скрипт `worker/probe_transcribe.py` для замера VRAM/RTF на целевой **RTX 2060** (~6 ГБ VRAM).
- Документация: [docs/GPU_PROBE.md](docs/GPU_PROBE.md). UI Горизонта не изменён; LICENSE не трогали.

## 0.2.0 — 2026-09-16

- Синяя, циановая и фиолетовая палитра «горизонта сингулярности».
- Тариф 0,06 ₽/мин с округлением итоговой стоимости вверх до копейки.
- Локальное извлечение аудио из WebM, MP4, MOV, MKV и AVI.
- Преобразование популярных аудиоформатов в WAV 16 кГц/моно.
- Прослушивание, скачивание, проверка файлов и понятные ошибки.
- Dockerfile, Compose, healthcheck, ограничения ресурсов и инструкция переноса.
- Проверки медиасценариев, браузера и Docker в CI.

GigaAM, реальные аккаунты, платежи и фискализация описаны в спецификации и пока не реализованы.
