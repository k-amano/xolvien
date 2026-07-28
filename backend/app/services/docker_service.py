"""Docker container management service."""
import codecs
import io
import os
import tarfile
import time
import docker
from docker.models.containers import Container
from docker.errors import DockerException, NotFound
from typing import Optional, Tuple, AsyncGenerator
import asyncio
from pathlib import Path

from app.config import get_settings

settings = get_settings()


class DockerService:
    """Service for managing Docker containers."""

    def __init__(self):
        """Initialize Docker client."""
        try:
            self.client = docker.from_env()
        except DockerException as e:
            raise RuntimeError(f"Failed to connect to Docker: {e}")

    def create_workspace_container(
        self,
        task_id: int,
        repository_url: str,
        branch_name: str,
    ) -> Tuple[str, str]:
        """
        Create and start a workspace container for a task.

        Args:
            task_id: Task ID
            repository_url: Git repository URL
            branch_name: Branch name to checkout

        Returns:
            Tuple of (container_id, container_name)
        """
        container_name = f"xolvien-task-{task_id}"
        workspace_path = f"{settings.task_data_path}/{task_id}"

        # Create volume for persistent storage
        volume_name = f"xolvien-task-{task_id}-data"

        try:
            # Create volume
            self.client.volumes.create(name=volume_name)

            # Mount host ~/.ssh/ for GitHub SSH authentication (read-only)
            # ~/.claude/ is NOT mounted — only the credentials file is copied
            # after container start to avoid carrying over stale backups/history
            ssh_dir = str(Path.home() / ".ssh")
            volumes = {
                volume_name: {"bind": "/workspace", "mode": "rw"},
                ssh_dir: {"bind": "/root/.ssh", "mode": "ro"},
            }

            # Start container
            container = self.client.containers.run(
                settings.workspace_image,
                name=container_name,
                detach=True,
                volumes=volumes,
                environment={
                    "TASK_ID": str(task_id),
                    "REPOSITORY_URL": repository_url,
                    "BRANCH_NAME": branch_name,
                    "GIT_USER_NAME": "Xolvien Bot",
                    "GIT_USER_EMAIL": "bot@xolvien.com",
                    "GIT_TERMINAL_PROMPT": "0",
                },
                working_dir="/workspace",
            )

            # Clone the default branch, then create a new task branch from it.
            # Always use -b to create a fresh branch — never reuse an existing remote branch.
            # If the repo is empty (new), git clone succeeds but there is no HEAD yet;
            # in that case we skip the checkout and let the agent make the first commit.
            clone_cmd = (
                f"git -c credential.helper= clone {repository_url} repo"
                f" && cd repo"
                f" && git checkout -b {branch_name}"
                f" || (cd repo && git checkout -b {branch_name} 2>/dev/null || true)"
            )
            exit_code, output = container.exec_run(
                ["bash", "-c", clone_cmd],
                workdir="/workspace",
                environment={"GIT_TERMINAL_PROMPT": "0"},
            )

            if exit_code != 0:
                raise RuntimeError(f"Failed to clone repository: {output.decode()}")

            # Copy only the credentials file into the xolvien user's home so
            # Claude Code CLI can authenticate without inheriting host backups,
            # history, or other unrelated files from ~/.claude/
            self.refresh_claude_credentials(container.id)

            # Grant ownership of cloned repo to xolvien user (for agent mode)
            container.exec_run(
                ["bash", "-c", "chown -R xolvien:xolvien /workspace/repo 2>/dev/null || true"],
                workdir="/workspace",
            )

            # Allow root to run git commands in xolvien-owned repo
            container.exec_run(
                ["bash", "-c", "git config --global --add safe.directory /workspace/repo"],
                workdir="/workspace",
            )

            return container.id, container_name

        except Exception as e:
            # Cleanup on failure
            try:
                self._remove_container(container_name)
                self.client.volumes.get(volume_name).remove()
            except:
                pass
            raise RuntimeError(f"Failed to create workspace container: {e}")

    def refresh_claude_credentials(self, container_id: str) -> None:
        """
        Copy the host's CURRENT Claude credentials file into the container.

        OAuth access tokens rotate: the copy made at container creation goes
        stale in long-lived containers, and the CLI then fails with
        401 "OAuth access token has been revoked". This is therefore called
        before every Claude flow (see ``ClaudeCodeService._write_runner``),
        not just at container creation, so runs always use the host's
        freshest credentials.

        A missing host file is not an error here — the CLI itself will fail
        with a clear auth error that the stream result check surfaces.
        """
        credentials_src = Path.home() / ".claude" / ".credentials.json"
        if not credentials_src.exists():
            return
        creds_data = credentials_src.read_bytes()
        container = self.client.containers.get(container_id)
        # Ensure the target directory exists before put_archive
        container.exec_run(["bash", "-c", "mkdir -p /home/xolvien/.claude"])
        tar_buf = io.BytesIO()
        with tarfile.open(fileobj=tar_buf, mode="w") as tar:
            info = tarfile.TarInfo(name=".credentials.json")
            info.size = len(creds_data)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(creds_data))
        tar_buf.seek(0)
        container.put_archive("/home/xolvien/.claude/", tar_buf)
        container.exec_run(
            ["bash", "-c", "chown -R xolvien:xolvien /home/xolvien/.claude"]
        )

    def ensure_container_running(self, container_id: str) -> None:
        """Start the container if it is stopped."""
        try:
            container = self.client.containers.get(container_id)
            if container.status != "running":
                container.start()
                # Wait until running (max 30s)
                for _ in range(30):
                    container.reload()
                    if container.status == "running":
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError(f"Container {container_id} did not start in time")
        except NotFound:
            raise RuntimeError(f"Container {container_id} not found")

    def execute_command(
        self,
        container_id: str,
        command: str,
        workdir: str = "/workspace/repo",
        user: Optional[str] = None,
    ) -> Tuple[int, str, str]:
        """
        Execute a command in the container.

        Args:
            container_id: Container ID
            command: Command to execute
            workdir: Working directory
            user: Container user to run as (None = container default/root).
                  HOME is set to match, so user-site installs (pip --user,
                  npm cache, ~/.cache browsers) resolve for that user.

        Returns:
            Tuple of (exit_code, stdout, stderr)
        """
        try:
            self.ensure_container_running(container_id)
            container = self.client.containers.get(container_id)
            kwargs = {}
            if user:
                kwargs["user"] = user
                kwargs["environment"] = {
                    "HOME": "/root" if user == "root" else f"/home/{user}"
                }
            exit_code, output = container.exec_run(
                ["bash", "-c", command],
                workdir=workdir,
                **kwargs,
            )
            return exit_code, output.decode("utf-8", errors="replace"), ""
        except NotFound:
            raise RuntimeError(f"Container {container_id} not found")
        except Exception as e:
            raise RuntimeError(f"Failed to execute command: {e}")

    def copy_uploads_to_container(
        self,
        container_id: str,
        host_dir: str,
        dest_dir: str = "/workspace/uploads",
    ) -> list[str]:
        """
        Copy a repository's uploaded files from the host volume into the task
        container so Claude Code can read them.

        Files are re-copied on every call (not persisted in the container) so
        they survive Reset & Rebuild and container recreation — the source of
        truth is the host upload directory.

        Args:
            container_id: Target container ID
            host_dir: Host directory holding the repository's uploads
            dest_dir: Destination directory inside the container

        Returns:
            The list of filenames copied (empty if the directory has no files).
        """
        if not os.path.isdir(host_dir):
            return []
        names = [n for n in sorted(os.listdir(host_dir))
                 if os.path.isfile(os.path.join(host_dir, n))]
        if not names:
            return []

        self.ensure_container_running(container_id)
        container = self.client.containers.get(container_id)
        # Reset the destination so removed uploads don't linger between runs.
        container.exec_run(["bash", "-c", f"rm -rf {dest_dir} && mkdir -p {dest_dir}"])

        tar_buf = io.BytesIO()
        with tarfile.open(fileobj=tar_buf, mode="w") as tar:
            for name in names:
                tar.add(os.path.join(host_dir, name), arcname=name)
        tar_buf.seek(0)
        container.put_archive(dest_dir, tar_buf)
        container.exec_run(
            ["bash", "-c", f"chown -R xolvien:xolvien {dest_dir} 2>/dev/null || true"]
        )
        return names

    async def execute_command_stream(
        self,
        container_id: str,
        command: str,
        workdir: str = "/workspace/repo",
        chunk_timeout: float = 60.0,
    ) -> AsyncGenerator[str, None]:
        """
        Execute a command and stream output chunk by chunk.
        chunk_timeout: seconds to wait for the next chunk before raising TimeoutError.
        """
        try:
            self.ensure_container_running(container_id)
            container = self.client.containers.get(container_id)

            exec_instance = container.exec_run(
                ["bash", "-c", command],
                workdir=workdir,
                stream=True,
                demux=True,
            )

            queue: asyncio.Queue[str | None] = asyncio.Queue()
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            loop = asyncio.get_event_loop()

            def _read_thread():
                try:
                    for stdout_chunk, _stderr_chunk in exec_instance.output:
                        raw = stdout_chunk or b""
                        if raw:
                            text = decoder.decode(raw)
                            if text:
                                loop.call_soon_threadsafe(queue.put_nowait, text)
                    remaining = decoder.decode(b"", final=True)
                    if remaining:
                        loop.call_soon_threadsafe(queue.put_nowait, remaining)
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

            import threading
            thread = threading.Thread(target=_read_thread, daemon=True)
            thread.start()

            while True:
                item = await asyncio.wait_for(queue.get(), timeout=chunk_timeout)
                if item is None:
                    break
                yield item

        except asyncio.TimeoutError:
            raise RuntimeError(f"Stream timed out: no output for {chunk_timeout}s")
        except NotFound:
            raise RuntimeError(f"Container {container_id} not found")
        except Exception as e:
            raise RuntimeError(f"Failed to execute streaming command: {e}")

    def get_container_status(self, container_id: str) -> str:
        """
        Get container status.

        Args:
            container_id: Container ID

        Returns:
            Container status (running, exited, etc.)
        """
        try:
            container = self.client.containers.get(container_id)
            return container.status
        except NotFound:
            return "not_found"
        except Exception:
            return "error"

    def stop_container(self, container_id: str) -> None:
        """
        Stop a container.

        Args:
            container_id: Container ID
        """
        try:
            container = self.client.containers.get(container_id)
            container.stop(timeout=10)
        except NotFound:
            pass
        except Exception as e:
            raise RuntimeError(f"Failed to stop container: {e}")

    def remove_container(self, container_id: str, task_id: int) -> None:
        """
        Remove a container and its volume.

        Args:
            container_id: Container ID
            task_id: Task ID (for volume name)
        """
        # Remove container
        self._remove_container(container_id)

        # Remove volume
        volume_name = f"xolvien-task-{task_id}-data"
        try:
            volume = self.client.volumes.get(volume_name)
            volume.remove()
        except NotFound:
            pass
        except Exception as e:
            raise RuntimeError(f"Failed to remove volume: {e}")

    def _remove_container(self, container_id_or_name: str) -> None:
        """
        Internal method to remove a container.

        Args:
            container_id_or_name: Container ID or name
        """
        try:
            container = self.client.containers.get(container_id_or_name)
            container.remove(force=True)
        except NotFound:
            pass
        except Exception as e:
            raise RuntimeError(f"Failed to remove container: {e}")


# Singleton instance
_docker_service: Optional[DockerService] = None


def get_docker_service() -> DockerService:
    """Get or create Docker service instance."""
    global _docker_service
    if _docker_service is None:
        _docker_service = DockerService()
    return _docker_service
