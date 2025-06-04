FROM iwaseyusuke/mininet:ubuntu-22.04

RUN apt-get update && \
    apt-get install -y software-properties-common && \
    add-apt-repository universe && \
    apt-get update && \
    apt-get install -y tmux python3-pip && \
    pip3 install --no-cache-dir ryu && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["tmux"]
