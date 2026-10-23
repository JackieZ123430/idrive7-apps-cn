@echo off
rem make-car-kit.cmd - Windows: build the apps and pack the car kit (dist\mgu-custom-apps.tar.gz).
rem Needs Python 3 and Node.js. Then: deploy\push-to-car.ps1
where py >nul 2>nul && (py -3 "%~dp0..\kit\tools\make_kit.py" %*) || python "%~dp0..\kit\tools\make_kit.py" %*
