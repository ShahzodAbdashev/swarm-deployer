FROM docker:27-dind
RUN apk add --no-cache --upgrade openssh-server openssh-client bash curl \
 && ssh-keygen -A \
 && (getent group docker || addgroup -S docker) \
 && adduser -D -s /bin/bash deploy && addgroup deploy docker \
 && echo 'deploy:sdtest-deploy-pass' | chpasswd \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && mkdir -p /home/deploy/.ssh && chown deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
COPY entry.sh /entry.sh
ENV DOCKER_TLS_CERTDIR=""
ENTRYPOINT ["/entry.sh"]
