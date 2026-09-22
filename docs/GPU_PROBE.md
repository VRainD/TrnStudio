# GPU-пробник GigaAM (локальный install)

Цель: проверить путь CUDA → PyTorch → GigaAM на **целевой карте RTX 2060** (типично **6 ГБ** VRAM; Super часто 8 ГБ) до подключения UI Горизонта к реальному ASR.

Интерфейс `prototype/` этим профилем **не меняется**. React и биллинг не запускаются. LICENSE-файлы не затрагиваются.

## Pin’ы (как в Dockerfile GigaAMGUI)

| Компонент | Версия |
|---|---|
| Base image | `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04` |
| PyTorch | `2.6.0+cu124` (+ torchaudio 2.6.0, torchvision 0.21.0) |
| GigaAM | git `0a3f1036d93287d5ef226911ec795bde8ef05d57` |
| Модель по умолчанию | `v3_e2e_rnnt` |

Источник pin’ов: публичный [dubr1k/GigaAMGUI](https://github.com/dubr1k/GigaAMGUI) Dockerfile. Код GigaAMGUI в образ **не vendoring’ится** — только официальный пакет GigaAM.

## Требования хоста

- NVIDIA driver + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- Docker Compose с GPU passthrough
- Для приёмки — **RTX 2060** (~6 ГБ; Super ~8 ГБ). Замеры с 3060 Ti / 4090 Laptop не считать эталоном

Сначала проброс GPU:

```bash
docker compose --profile gpu-check run --rm gpu-check
```

## Сборка и запуск

```bash
docker compose --profile gpu-probe build gpu-probe
docker compose --profile gpu-probe run --rm gpu-probe
```

По умолчанию скрипт:

1. печатает имя устройства и VRAM;
2. загружает `v3_e2e_rnnt` (первый запуск качает веса в volume `gpu_probe_data`);
3. гоняет короткий `transcribe` на 3 с тишины (проверка decode-пути);
4. печатает peak VRAM и RTF в JSON.

Свой WAV (PCM 16 kHz mono, **≤ ~25 с** для короткого API):

```bash
docker compose --profile gpu-probe run --rm \
  -v "$PWD/samples:/app/samples:ro" \
  gpu-probe --audio /app/samples/clip.wav
```

Только загрузка модели:

```bash
docker compose --profile gpu-probe run --rm gpu-probe --load-only
```

Сохранить отчёт:

```bash
docker compose --profile gpu-probe run --rm \
  -v "$PWD:/out" \
  gpu-probe --json-out /out/gpu-probe-report.json
```

## VRAM / RTF — ориентиры для RTX 2060 (~6 ГБ)

| Метрика | Ориентир | Куда писать факт |
|---|---|---|
| Полный VRAM карты | ~6144 MiB (типично); Super ~8192 MiB | поле `total_vram_mib` в выводе probe |
| Peak VRAM после load + short infer | измерить на хосте; запас под ОС/дисплей тесный на 6 ГБ | `acceptance_hints_rtx2060.measured_peak_vram_mib` |
| RTF (wall / audio duration) | желательно **< 1.0** для интерактивного локального сценария | `measured_rtf` |
| Имя устройства | должно содержать `2060` для приёмочного прогона | `measured_device_name` |

Пока в репозитории нет заполненных цифр с RTX 2060 — это ожидаемо: cloud/CI без этой GPU. **Риск:** 6 ГБ заметно теснее прежнего ориентира 16 ГБ (3060 Ti) для GigaAM RNNT — при OOM уменьшать chunk/batch. После первого прогона на целевой машине приложите JSON-отчёт к issue/PR и обновите таблицу ниже.

### Фактические замеры (заполнить на RTX 2060)

| Дата | Драйвер / CUDA host | Модель | Peak VRAM (MiB) | RTF | Примечание |
|---|---|---|---|---|---|
| — | — | `v3_e2e_rnnt` | — | — | ещё не прогнано на RTX 2060 |

## Ограничения этого шага

- Короткий `model.transcribe` официально до ~25 с. Длинные записи → chunking / longform в следующем шаге phase 1.
- Нет диаризации, LLM, Live, очереди jobs, экспорта SRT/VTT — это следующие PR полного локального install.
- Профиль `gpu-probe` не поднимает сервис студии на `:4180`.

## Связанные файлы

- `worker/Dockerfile.gpu-probe`
- `worker/probe_transcribe.py`
- сервис `gpu-probe` в `compose.yaml`
