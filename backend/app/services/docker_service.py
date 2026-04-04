"""Docker container management service."""
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
        container_name = f"karakuri-task-{task_id}"
        workspace_path = f"{settings.task_data_path}/{task_id}"

        # Create volume for persistent storage
        volume_name = f"karakuri-task-{task_id}-data"

        try:
            # Create volume
            self.client.volumes.create(name=volume_name)

            # Mount host ~/.claude/ for Claude Code CLI authentication
            # Mount host ~/.ssh/ for GitHub SSH authentication (read-only)
            claude_dir = str(Path.home() / ".claude")
            ssh_dir = str(Path.home() / ".ssh")
            volumes = {
                volume_name: {"bind": "/workspace", "mode": "rw"},
                claude_dir: {"bind": "/root/.claude", "mode": "rw"},
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
                    "GIT_USER_NAME": "Karakuri Bot",
                    "GIT_USER_EMAIL": "bot@karakuri.local",
                    "GIT_TERMINAL_PROMPT": "0",
                },
                working_dir="/workspace",
            )

            # Clone repository (disable credential prompting for non-interactive exec)
            clone_cmd = f"git -c credential.helper= clone {repository_url} repo && cd repo && git checkout -b {branch_name} || git checkout {branch_name}"
            exit_code, output = container.exec_run(
                ["bash", "-c", clone_cmd],
                workdir="/workspace",
                environment={"GIT_TERMINAL_PROMPT": "0"},
            )

            if exit_code != 0:
                # If clone/checkout fails, try without creating new branch
                clone_cmd = f"git -c credential.helper= clone {repository_url} repo && cd repo && git checkout {branch_name}"
                exit_code, output = container.exec_run(
                    ["bash", "-c", clone_cmd],
                    workdir="/workspace",
                    environment={"GIT_TERMINAL_PROMPT": "0"},
                )

            if exit_code != 0:
                raise RuntimeError(f"Failed to clone repository: {output.decode()}")

            return container.id, container_name

        except Exception as e:
            # Cleanup on failure
            try:
                self._remove_container(container_name)
                self.client.volumes.get(volume_name).remove()
            except:
                pass
            raise RuntimeError(f"Failed to create workspace container: {e}")

    def execute_command(
        self,
        container_id: str,
        command: str,
        workdir: str = "/workspace/repo",
    ) -> Tuple[int, str, str]:
        """
        Execute a command in the container.

        Args:
            container_id: Container ID
            command: Command to execute
            workdir: Working directory

        Returns:
            Tuple of (exit_code, stdout, stderr)
        """
        try:
            container = self.client.containers.get(container_id)
            exit_code, output = container.exec_run(
                ["bash", "-c", command],
                workdir=workdir,
            )
            return exit_code, output.decode(), ""
        except NotFound:
            raise RuntimeError(f"Container {container_id} not found")
        except Exception as e:
            raise RuntimeError(f"Failed to execute command: {e}")

    async def execute_command_stream(
        self,
        container_id: str,
        command: str,
        workdir: str = "/workspace/repo",
    ) -> AsyncGenerator[str, None]:
        """
        Execute a command and stream output line by line.

        Args:
            container_id: Container ID
            command: Command to execute
            workdir: Working directory

        Yields:
            Output lines
        """
        try:
            container = self.client.containers.get(container_id)

            # Execute with streaming
            exec_instance = container.exec_run(
                ["bash", "-c", command],
                workdir=workdir,
                stream=True,
                demux=False,
            )

            for chunk in exec_instance.output:
                if chunk:
                    # Decode and yield each chunk
                    text = chunk.decode("utf-8", errors="replace")
                    yield text
                    # Small delay to prevent overwhelming the client
                    await asyncio.sleep(0.01)

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
        volume_name = f"karakuri-task-{task_id}-data"
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
